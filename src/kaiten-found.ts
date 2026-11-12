/**
 * `kaiten found` — записать находку: дефект продукта, замеченный по ходу
 * другой работы (`core/found.ts`, владелец 12.11.2026).
 *
 * Команда делает два шага и не ждёт второго:
 *   1. заметка — сразу, операцией в хранилище (как любая команда записи);
 *   2. исследование — отдельным фоновым процессом (скрытая команда `__found`):
 *      снимок основной ветки, модель только на чтение, сверка её ответа.
 *      Подтвердилась — задача в «Находках»; нет — вердикт в заметке.
 *
 * ОЧЕРЕДЬ. Исследование — минуты и деньги, поэтому на машине идёт одно: замок
 * `kaiten-found.lock` в хранилище. Кто не получил замок, выходит: держатель
 * разберёт и его заметку — она лежит файлом в `found-queue/`. Заметка
 * вынимается из очереди до запуска модели: упавшее исследование не повторяется
 * само, заметка остаётся «не исследована», и её добирает скрипт владельца
 * (`npm run found`). Так сбой не превращается в бесконечные запуски.
 *
 * `KAITEN_FOUND` — как `KAITEN_SEND`: `off` — не исследовать, `inline` —
 * сразу, в этом процессе (тесты и пробные прогоны).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { modelProblem } from './claude-agent.js';
import { foundSetting } from './config.js';
import { serializeTaskDocument } from './core/document.js';
import { FINDING_STATE_WORDS, findingPath, isFindingPath, listFindings, newFindingText, type Finding, type FindingVerdict } from './core/found.js';
import { newTaskText, type Op } from './core/task-ops.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { ulid } from './core/ulid.js';
import { investigate, type Investigator } from './found-investigate.js';
import { currentPerson, findTask, loadTasks, parse, printNotices, refreshLocalCopy, resolveContext, startSend, stringFlag, today, UsageError, type Context } from './kaiten-cli.js';
import { commit } from './kaiten-write.js';
import { recordOp, tryLock } from './store-write.js';
import { listEntries, readBlobs, type StoreEntry } from './task-store.js';

export const FOUND_HELP = `kaiten found "<что не так>" — записать дефект продукта, замеченный по ходу другой работы.

Только дефект: продукт делает не то, что должен. Улучшения, рефакторинг и
попутную работу сюда не пишут — о них скажите человеку в ответе.

Команда записывает заметку и сразу возвращает управление. Дефект проверяет
отдельный проверяющий по основной ветке; подтвердится — у людей появится
задача в «Находках». Результата не ждите, задачу не заводите и находку сами
не чините: продолжайте свою работу и назовите находку человеку в ответе.

Флаги:
  --where <где>     обязательно: файл и строка или экран, где это видно
  --why <почему>    обязательно: что происходит и почему это дефект, а не
                    особенность — как должно быть и откуда вы это знаете
  --from <задача>   задача, по ходу которой нашли
  --list            находки этого репозитория и что с ними стало

Пример:
  kaiten found "Дата в заголовке отчёта — месяц/день/год" --from PRJ-123 \\
    --where "src/report/header.ts:41" \\
    --why "3 октября выводится как 10/3/2026; в остальном отчёте и в тесте format-date — день.месяц.год"
`;

const QUEUE_DIR = 'found-queue';
const FOUND_LOCK = 'kaiten-found.lock';
/** Замок старше — исследователь завис или убит: чуть больше предела одного исследования. */
const LOCK_STALE_MS = 30 * 60_000;

interface QueueItem {
  id: string;
  /** Папка репозитория кода, из которой записали находку: из неё берётся основная ветка. */
  workDir: string;
}

export function enqueueFinding(store: string, item: QueueItem): void {
  mkdirSync(join(store, QUEUE_DIR), { recursive: true });
  writeFileSync(join(store, QUEUE_DIR, `${item.id}.json`), JSON.stringify(item));
}

/** Следующая заметка очереди; файл вынимается сразу — исследование не повторяется само. */
function takeNext(store: string): QueueItem | null {
  const dir = join(store, QUEUE_DIR);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<QueueItem>;
      rmSync(path, { force: true });
      if (typeof raw.id === 'string' && typeof raw.workDir === 'string') return { id: raw.id, workDir: raw.workDir };
    } catch {
      rmSync(path, { force: true });
    }
  }
  return null;
}

function queueEmpty(store: string): boolean {
  const dir = join(store, QUEUE_DIR);
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

// ── чтение находок ───────────────────────────────────────────────────────

function findingFiles(store: string, entries: readonly StoreEntry[]): Array<{ path: string; text: string }> {
  const wanted = entries.filter((e) => isFindingPath(e.path) && e.path.endsWith('.md'));
  const blobs = readBlobs(
    store,
    wanted.map((e) => e.sha),
  );
  return wanted.map((e) => ({ path: e.path, text: blobs.get(e.sha)?.toString('utf8') ?? '' }));
}

/** Файлы репозитория задач для снимка: задачи, журналы и прежние находки. */
export function snapshotFiles(tasks: readonly TaskRecord[], findings: ReadonlyArray<{ path: string; text: string }>): Array<{ path: string; text: string }> {
  const files = tasks.flatMap((t) => [
    { path: t.path, text: serializeTaskDocument(t.fm, t.body) },
    ...(t.log !== null ? [{ path: t.path.replace(/\.md$/, '.log.md'), text: t.log }] : []),
  ]);
  return [...files, ...findings];
}

// ── вердикт → операция ───────────────────────────────────────────────────

/** Операция для вердикта; у подтверждённой — файл задачи в «Находках». */
export function verdictOp(finding: Finding, verdict: FindingVerdict, date: string): Op | { error: string } {
  if (verdict.state === 'rejected') return { kind: 'found-verdict', id: finding.fm.id, state: 'rejected', reason: verdict.reason };
  if (verdict.state === 'duplicate') return { kind: 'found-verdict', id: finding.fm.id, state: 'duplicate', reason: verdict.reason, task: { slug: verdict.of.slug } };
  const text = newTaskText(
    {
      id: ulid(),
      slug: verdict.task.slug,
      title: verdict.task.title,
      summary: verdict.task.summary,
      type: 'bug',
      repo: finding.fm.repo,
      related: finding.fm.from ? [finding.fm.from] : undefined,
      createdBy: finding.fm.created_by,
      createdVia: 'agent',
      body: verdict.task.body,
      found: true,
    },
    date,
  );
  if (typeof text !== 'string') return text;
  return { kind: 'found-verdict', id: finding.fm.id, state: 'confirmed', reason: verdict.reason, task: { slug: verdict.task.slug, text } };
}

/**
 * Записать вердикт. Задача подтверждённой находки не прошла проверку формата —
 * находка не подтверждена: карточка, которую нельзя записать, не доказательство.
 */
export function recordVerdict(store: string, finding: Finding, verdict: FindingVerdict, date: string): { state: FindingVerdict['state']; summary: string } | { error: string } {
  const op = verdictOp(finding, verdict, date);
  const first = 'error' in op ? op : recordOp(store, op, `находка: ${finding.title}`, date);
  if (!('error' in first)) return { state: verdict.state, summary: first.summary };
  if (verdict.state !== 'confirmed') return first;
  const reason = `Задача по находке не прошла проверку формата: ${first.error}. Исследователь писал: ${verdict.reason}`;
  const second = recordOp(store, { kind: 'found-verdict', id: finding.fm.id, state: 'rejected', reason }, `находка: ${finding.title}`, date);
  return 'error' in second ? second : { state: 'rejected', summary: second.summary };
}

// ── фоновое исследование ─────────────────────────────────────────────────

async function investigateItem(ctx: Context, item: QueueItem, run?: Investigator): Promise<void> {
  const setting = foundSetting(ctx.loaded.project);
  if (setting.state !== 'on' || modelProblem(setting.model)) return;
  const { index, entries } = loadTasks(ctx);
  const files = findingFiles(ctx.store, entries);
  const finding = listFindings(files).find((f) => f.fm.id === item.id);
  if (!finding || finding.fm.state !== 'pending') return;
  const repo = ctx.loaded.project.repos.find((r) => r.name === finding.fm.repo);
  if (!repo) return;
  const result = await investigate({
    finding,
    tasks: index.tasks,
    // Сама заметка исследователю не нужна среди «прежних находок»: она в задании.
    snapshot: { codeDir: item.workDir, branch: repo.branch, files: snapshotFiles(index.tasks, files.filter((f) => f.path !== findingPath(finding.fm.id))) },
    model: setting.model,
    run,
  });
  // Исследование не состоялось — заметка остаётся неисследованной: её доберёт скрипт владельца.
  if ('error' in result) return;
  const recorded = recordVerdict(ctx.store, finding, result.verdict, today());
  if ('error' in recorded) return;
  refreshLocalCopy(ctx);
  await startSend(ctx);
}

/** Разобрать очередь исследований; замок занят — этим занят другой процесс, он заберёт и наше. */
export async function runFoundQueue(ctx: Context, run?: Investigator): Promise<void> {
  for (;;) {
    const release = tryLock(ctx.store, FOUND_LOCK, LOCK_STALE_MS);
    if (!release) return;
    try {
      for (let item = takeNext(ctx.store); item !== null; item = takeNext(ctx.store)) {
        try {
          await investigateItem(ctx, item, run);
        } catch {
          // Одна неудача — не повод бросить остальные заметки очереди.
        }
      }
    } finally {
      release();
    }
    // Заметка могла встать в очередь, пока мы снимали замок, а её процесс уже вышел.
    if (queueEmpty(ctx.store)) return;
  }
}

async function startInvestigation(ctx: Context): Promise<void> {
  const mode = process.env.KAITEN_FOUND;
  if (mode === 'off') return;
  if (mode === 'inline') {
    await runFoundQueue(ctx);
    return;
  }
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__found'], {
    cwd: ctx.workDir,
    // Как у фоновой отправки: без «detached» процесс не переживает команду, а консоли у него нет.
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

// ── команда ──────────────────────────────────────────────────────────────

function printList(ctx: Context): void {
  const { index, entries } = loadTasks(ctx);
  const findings = listFindings(findingFiles(ctx.store, entries)).filter((f) => f.fm.repo === ctx.currentRepo);
  if (findings.length === 0) {
    console.log('Находок в этом репозитории нет.');
    return;
  }
  console.log(`Находки репозитория ${ctx.currentRepo}: ${findings.length}\n`);
  for (const f of findings.reverse()) {
    const task = f.fm.task ? index.tasks.find((t) => t.slug === f.fm.task) : undefined;
    const where = task ? ` — задача ${refOf(task)}` : '';
    console.log(`${f.fm.created}  ${FINDING_STATE_WORDS[f.fm.state]}${where}  ${f.title}`);
    if (f.reason && f.fm.state !== 'confirmed') console.log(`            ${f.reason}`);
  }
}

async function found(args: string[]): Promise<void> {
  const { values, positionals } = parse('found', args, { where: { type: 'string' }, why: { type: 'string' }, from: { type: 'string' }, list: { type: 'boolean' } }, 1);
  const ctx = resolveContext();
  printNotices(ctx);
  if (values.list) {
    printList(ctx);
    return;
  }
  const setting = foundSetting(ctx.loaded.project);
  if (setting.state !== 'on') {
    const why = setting.state === 'off' ? 'В этом проекте находки не записывают' : 'Находки в этом проекте ещё не настроены — это делает владелец проекта';
    throw new UsageError(`${why}. Задачу не заводите: расскажите о дефекте человеку в ответе.`, 1);
  }
  // Всё, чего не хватает, — одним отказом и готовой командой: агент исполняет отказы, а не подсказки.
  const title = positionals[0]?.trim() ?? '';
  const where = stringFlag(values, 'where')?.trim() ?? '';
  const why = stringFlag(values, 'why')?.trim() ?? '';
  const fromRef = stringFlag(values, 'from')?.trim();
  const problems: string[] = [];
  if (!title) problems.push('что не так — одной строкой, первым аргументом');
  if (!where) problems.push('--where: файл и строка или экран, где это видно');
  if (!why) problems.push('--why: что происходит и почему это дефект — как должно быть и откуда вы это знаете');
  if (problems.length > 0) {
    const quote = (s: string): string => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
    const command = ['kaiten found', quote(title || '<что не так>'), fromRef ? `--from ${quote(fromRef)}` : '', `--where ${quote(where || '<где>')}`, `--why ${quote(why || '<почему это дефект>')}`].filter(Boolean).join(' ');
    throw new UsageError(`Не записано:${problems.map((p) => `\n  - ${p}`).join('')}\n\nТак находка записывается:\n\n${command}`, 1);
  }
  const from = fromRef ? findTask(loadTasks(ctx).index, fromRef).slug : undefined;
  const id = ulid();
  const text = newFindingText({ id, repo: ctx.currentRepo, from, createdBy: currentPerson(ctx.loaded.people), title, where, seen: why }, today());
  if (typeof text !== 'string') throw new UsageError(`Не записано: ${text.error}.`, 1);
  // Очередь — до записи: записанная заметка без места в очереди ждала бы скрипта владельца.
  enqueueFinding(ctx.store, { id, workDir: ctx.workDir });
  try {
    await commit(ctx, { kind: 'found-note', id, text }, 'находка');
  } catch (error) {
    rmSync(join(ctx.store, QUEUE_DIR, `${id}.json`), { force: true });
    throw error;
  }
  await startInvestigation(ctx);
  console.log('Дефект проверит отдельный проверяющий по основной ветке. Результата не ждите, задачу не заводите и находку не чините: продолжайте свою работу и назовите находку человеку в ответе.');
}

/** Скрытая команда: фоновое исследование очереди находок. Молчит. */
export async function foundWorker(): Promise<void> {
  await runFoundQueue(resolveContext());
}

export const FOUND_COMMANDS: Record<string, (args: string[]) => Promise<void>> = { found };
