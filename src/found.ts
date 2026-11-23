/**
 * Скрипт владельца: исследование находок (`core/found.ts`), до которых не
 * дошла фоновая проверка `kaiten found`.
 *
 *   pnpm run found --tasks <адрес> --code acme-app=<папка>
 *   pnpm run found --tasks <адрес> --apply <файл результатов>
 *
 * Без `--apply` — только исследование и отчёт: ни в задачи, ни в Kaiten ничего
 * не пишется. `--apply` модель не запускает, а применяет ровно переданный
 * файл; несогласны с находкой — удалите её запись из файла.
 *
 * ЧТО ИССЛЕДУЕТСЯ — только заметки `kaiten found` в состоянии «не исследована»:
 * исследование на машине агента упало, или там нет модели. Применение пишет
 * вердикт в заметку, а подтверждённой заводит задачу в «Находках».
 *
 * ЗАДАЧИ ПРОВЕРКА НЕ ТРОГАЕТ. Режима `--legacy` (разбор задач, которые агенты
 * завели до находок) больше нет: отбор «завёл агент, во „Входящих“, без
 * приоритета» не отличал заметку о дефекте от работы, которую агент поставил
 * по просьбе человека, — под проверку попали story и tech с критериями, а
 * вердикт «это не дефект, а новая работа» читался как «отменить» (12.11.2026).
 * Задача, заведённая `kaiten new`, — работа на разбор человеку, а не находка.
 *
 * ФЛАГИ
 *   --tasks <адрес|папка>  репозиторий задач; --apply — только адрес
 *   --code <репо>=<папка>  рабочая копия репозитория кода: из неё берётся
 *                          основная ветка, на какой ветке сама папка — неважно
 *   --only <id>            одна заметка
 *   --limit N              не больше N исследований
 *   --model <модель>       по умолчанию — из kaiten.found; Haiku не используем
 *   --out <папка>          куда положить отчёт и файл результатов
 *   --apply <файл>         применить файл результатов
 *
 * Исследования идут по одному. Коды выхода: 0 — ок; 1 — были ошибки; 2 —
 * ошибка аргументов.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { modelProblem } from './claude-agent.js';
import { foundSetting } from './config.js';
import { FINDINGS_DIR, FINDING_STATE_WORDS, findingPath, isFindingPath, listFindings, pendingFindings, type FindingVerdict } from './core/found.js';
import { buildIndex, type TaskRecord } from './core/tasks-index.js';
import { investigate } from './found-investigate.js';
import { today } from './kaiten-cli.js';
import { recordVerdict, snapshotFiles } from './kaiten-found.js';
import { loadOwnerProject } from './owner-project.js';
import { syncStore } from './store-write.js';
import { listEntries, readBlobs, readStoreTree } from './task-store.js';
import { readTasksTree } from './tasks-files.js';
import { endWith } from './exit.js';

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

function argValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
}

// ── файл результатов ─────────────────────────────────────────────────────

const ResultSchema = z
  .object({
    /** id заметки. */
    id: z.string(),
    title: z.string(),
    state: z.enum(['confirmed', 'rejected', 'duplicate']),
    reason: z.string(),
    /** Подтверждённой находке — задача. */
    task: z.object({ title: z.string(), slug: z.string(), summary: z.string(), body: z.string() }).strict().optional(),
    /** Повтор — задача, где дефект уже записан (slug). */
    of: z.string().optional(),
  })
  .strict();
type Result = z.infer<typeof ResultSchema>;

const ResultsFileSchema = z
  .object({
    version: z.literal(1),
    project: z.string(),
    created: z.string(),
    model: z.string(),
    // `legacy` — файлы прежнего разбора задач агентов: читаются, чтобы отказать словами, а не ошибкой схемы.
    kind: z.enum(['notes', 'legacy']),
    results: z.array(ResultSchema),
  })
  .strict();
type ResultsFile = z.infer<typeof ResultsFileSchema>;

function toResult(id: string, title: string, verdict: FindingVerdict): Result {
  if (verdict.state === 'confirmed') return { id, title, state: 'confirmed', reason: verdict.reason, task: verdict.task };
  if (verdict.state === 'duplicate') return { id, title, state: 'duplicate', reason: verdict.reason, of: verdict.of.slug };
  return { id, title, state: 'rejected', reason: verdict.reason };
}

// ── что исследовать ──────────────────────────────────────────────────────

interface Source {
  tasks: TaskRecord[];
  findingFiles: Array<{ path: string; text: string }>;
}

function readSource(owner: ReturnType<typeof loadOwnerProject>): Source {
  if (owner.source.kind === 'store') {
    const store = owner.source.store;
    const entries = listEntries(store);
    const tree = readStoreTree(store, entries);
    const wanted = entries.filter((e) => isFindingPath(e.path) && e.path.endsWith('.md'));
    const blobs = readBlobs(
      store,
      wanted.map((e) => e.sha),
    );
    return { tasks: buildIndex(tree.files, tree.logs).tasks, findingFiles: wanted.map((e) => ({ path: e.path, text: blobs.get(e.sha)?.toString('utf8') ?? '' })) };
  }
  if (owner.source.kind === 'dir') {
    const dir = owner.source.dir;
    const tree = readTasksTree(dir);
    const folder = join(dir, FINDINGS_DIR);
    const names = existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith('.md')) : [];
    return { tasks: buildIndex(tree.files, tree.logs).tasks, findingFiles: names.map((n) => ({ path: `${FINDINGS_DIR}/${n}`, text: readFileSync(join(folder, n), 'utf8') })) };
  }
  return fail('--config без --tasks: укажите, откуда брать задачи');
}

const LEGACY_GONE =
  'Разбора задач агентов (--legacy) больше нет: проверка находок исследует только заметки kaiten found. ' +
  'Задача, заведённая kaiten new, — работа на разбор человеку: отменить её или оставить, решают в Kaiten.';

// ── сухой прогон ─────────────────────────────────────────────────────────

async function dryRun(argv: string[]): Promise<void> {
  const owner = loadOwnerProject(argv);
  const { key, project } = owner.loaded;
  if (foundSetting(project).state === 'off') fail(`У проекта ${project.title} находки не включены (kaiten.found в kaiten.json).`);
  const model = argValue(argv, '--model') ?? project.kaiten.found?.model ?? fail('Не задана модель: --model');
  const badModel = modelProblem(model);
  if (badModel) fail(`--model: ${badModel}.`);

  const code = new Map<string, string>();
  for (const spec of argValues(argv, '--code')) {
    const m = /^([^=]+)=(.+)$/.exec(spec);
    if (!m) fail(`--code ${spec}: нужно <репозиторий>=<папка>`);
    const [, name, path] = m;
    if (!project.repos.some((r) => r.name === name)) fail(`--code ${name}: в проекте нет такого репозитория (есть: ${project.repos.map((r) => r.name).join(', ')})`);
    const dir = resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--code ${name}: нет папки ${dir}`);
    code.set(name, dir);
  }
  if (code.size === 0) fail('Укажите папки с кодом: --code <репозиторий>=<папка>');

  const source = readSource(owner);
  const only = argValue(argv, '--only');
  const limitRaw = argValue(argv, '--limit');
  const limit = limitRaw === undefined ? Number.MAX_SAFE_INTEGER : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit: целое число больше нуля');

  // Только заметки `kaiten found`: задачи проекта под проверку не попадают никогда.
  let pending = pendingFindings(source.findingFiles);
  if (only) {
    pending = pending.filter((f) => f.fm.id === only);
    if (pending.length === 0) fail(`Неисследованной находки ${only} нет`);
  }
  const targets = pending.map((f) => ({ finding: f, name: f.title, exclude: findingPath(f.fm.id) }));
  const withCode = targets.filter((t) => code.has(t.finding.fm.repo));
  const picked = withCode.slice(0, limit);
  const noCode = [...new Set(targets.filter((t) => !code.has(t.finding.fm.repo)).map((t) => t.finding.fm.repo))];

  console.log(`Проект ${project.title}: неисследованных находок — ${targets.length}, исследую ${picked.length}. Модель ${model}.`);
  if (noCode.length > 0) console.log(`Без папки с кодом пропущены репозитории: ${noCode.map((r) => `--code ${r || '<репозиторий>'}=<папка>`).join(' ')}`);

  const results: Result[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  let cost = 0;
  for (const [i, target] of picked.entries()) {
    const repo = project.repos.find((r) => r.name === target.finding.fm.repo);
    const files = snapshotFiles(source.tasks, source.findingFiles).filter((f) => f.path !== target.exclude && f.path !== target.exclude.replace(/\.md$/, '.log.md'));
    const done = await investigate({
      finding: target.finding,
      tasks: source.tasks.filter((t) => t.path !== target.exclude),
      snapshot: { codeDir: code.get(target.finding.fm.repo) ?? '', branch: repo?.branch ?? 'main', files },
      model,
    });
    if ('error' in done) {
      failed.push({ name: target.name, error: done.error });
      console.log(`[${i + 1}/${picked.length}] ${target.name} — исследование не состоялось: ${done.error}`);
      continue;
    }
    cost += done.costUsd;
    results.push(toResult(target.finding.fm.id, target.name, done.verdict));
    console.log(`[${i + 1}/${picked.length}] ${target.name} — ${FINDING_STATE_WORDS[done.verdict.state]}`);
  }

  const created = new Date().toISOString();
  const file: ResultsFile = { version: 1, project: key, created, model, kind: 'notes', results };
  const out = resolve(argValue(argv, '--out') ?? join(tmpdir(), 'kaiten-found'));
  mkdirSync(out, { recursive: true });
  const stamp = created.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const jsonPath = join(out, `${key}-${stamp}.json`);
  const mdPath = join(out, `${key}-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, report(project.title, file, failed), 'utf8');

  const count = (s: Result['state']): number => results.filter((r) => r.state === s).length;
  console.log(`\nИсследовано ${results.length}: подтверждено — ${count('confirmed')}, не подтверждено — ${count('rejected')}, уже записано — ${count('duplicate')}; не состоялось — ${failed.length}. Стоимость ≈ $${cost.toFixed(2)}.`);
  console.log(`Отчёт: ${mdPath}`);
  console.log(`Результаты: ${jsonPath}`);
  console.log('\nСухой прогон: ни в задачи, ни в Kaiten ничего не записано. Применить: --apply <файл результатов>.');
  if (failed.length > 0) process.exitCode = 1;
}

function report(project: string, file: ResultsFile, failed: ReadonlyArray<{ name: string; error: string }>): string {
  const out = [`# Находки: ${project}`, '', `Неисследованные находки · ${file.created.slice(0, 16).replace('T', ' ')} UTC · модель ${file.model}`, ''];
  const block = (title: string, state: Result['state'], note: string): void => {
    const items = file.results.filter((r) => r.state === state);
    if (items.length === 0) return;
    out.push(`## ${title} (${items.length})`, '', note, '');
    for (const r of items) {
      out.push(`### ${r.title}`, '', r.reason, '');
      if (r.of) out.push(`Уже записано в задаче: ${r.of}`, '');
      if (r.task) out.push(`**${r.task.title}** — ${r.task.summary}`, '', r.task.body.trim(), '');
    }
  };
  block('Подтверждено', 'confirmed', 'Применение заведёт эти задачи в «Находках».');
  block('Не подтверждено', 'rejected', 'Применение запишет вердикт в заметку; карточки не будет. Задачи проекта при этом не меняются.');
  block('Уже записано', 'duplicate', 'Применение запишет в заметку, где дефект уже записан.');
  if (failed.length > 0) out.push(`## Исследование не состоялось (${failed.length})`, '', ...failed.map((f) => `- ${f.name} — ${f.error}`), '');
  return `${out.join('\n')}\n`;
}

// ── применение ───────────────────────────────────────────────────────────

async function apply(argv: string[], path: string): Promise<void> {
  const owner = loadOwnerProject(argv);
  const { key, project } = owner.loaded;
  if (owner.source.kind !== 'store') fail('--apply пишет в задачи — только из хранилища задач: --tasks <адрес репозитория задач>');
  const store = owner.source.store;
  if (foundSetting(project).state !== 'on') fail('Колонки «Находки» в Kaiten нет — сначала kaiten.found в kaiten.json и pnpm run setup (план → --apply).');

  let file: ResultsFile;
  try {
    file = ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
  } catch (error) {
    fail(`Файл результатов не читается: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
  if (file.project !== key) fail(`Файл результатов — проекта ${file.project}, а задачи — ${key}`);

  const date = today();
  let applied = 0;
  let errors = 0;
  const source = readSource(owner);

  if (file.kind !== 'notes') fail(LEGACY_GONE);
  const findings = listFindings(source.findingFiles);
  for (const result of file.results) {
    const finding = findings.find((f) => f.fm.id === result.id);
    if (!finding || finding.fm.state !== 'pending') {
      console.log(`${result.title} — уже исследована, пропущено`);
      continue;
    }
    const of = result.of ? source.tasks.find((t) => t.slug === result.of) : undefined;
    const verdict: FindingVerdict | null =
      result.state === 'confirmed' && result.task ? { state: 'confirmed', reason: result.reason, task: result.task } : result.state === 'duplicate' && of ? { state: 'duplicate', reason: result.reason, of } : result.state === 'rejected' ? { state: 'rejected', reason: result.reason } : null;
    const recorded = verdict ? recordVerdict(store, finding, verdict, date) : { error: 'в записи результата не хватает задачи' };
    if ('error' in recorded) {
      console.error(`Не применено: ${result.title} — ${recorded.error}`);
      errors += 1;
      continue;
    }
    applied += 1;
    console.log(`${result.title} — ${recorded.summary}`);
  }

  if (applied > 0) syncStore(store);
  console.log(`\nПрименено ${applied}. Карточки обновит ближайшая синхронизация (kaiten pull).`);
  if (errors > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('pnpm run found --tasks <адрес> --code <репо>=<папка> [--only <id>] [--limit N] [--model M] [--out <папка>]');
    console.log('pnpm run found --tasks <адрес> --apply <файл результатов>');
    return;
  }
  // Раньше всего остального: разбора задач нет ни с какими флагами.
  if (argv.includes('--legacy')) fail(LEGACY_GONE);
  if (argv.includes('--apply')) {
    const file = argValue(argv, '--apply') ?? fail('--apply <файл результатов>: какой файл применить');
    await apply(argv, file);
  } else {
    await dryRun(argv);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  endWith(1);
});
