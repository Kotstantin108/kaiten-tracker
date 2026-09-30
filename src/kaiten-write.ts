/**
 * Команды записи CLI `kaiten`: `new`, `check`, `log`, `block`, `cancel`,
 * `review`, `done`, `edit` (`start` — в `kaiten-start.ts`). Каждая: проверить задачу → записать операцию локально (журнал +
 * коммит, `store-write.ts`) → обновить копию для чтения → отправить общим в
 * фоне. Агент не ждёт сеть; что не применилось при отправке, скажет
 * следующая команда.
 *
 * Kaiten обновляется при включённой синхронизации (`sync.kaiten`): текст —
 * в фоне, статус — сразу и сначала в карточке (`moveCardFirst`): отказ доски
 * останавливает команду.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { contentHash, serializeTaskDocument } from './core/document.js';
import { SLUG_RE } from './core/lint.js';
import { criteriaText } from './core/skeleton.js';
import { TASK_TYPES, type TaskType } from './core/schema.js';
import { ATTACHMENT_MAX_BYTES, attachmentNameProblem, BLOCKABLE, CANCELLABLE, matchItem, moveProblem, newTaskText, slugify, uniqueSlug, type Op } from './core/task-ops.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { ulid } from './core/ulid.js';
import {
  currentPerson,
  findTask,
  loadTasks,
  cardNotMovedNote,
  moveCardFirst,
  parse,
  printNotices,
  refreshLocalCopy,
  resolveContext,
  startSend,
  stringFlag,
  TASK_REF_HELP,
  today,
  UsageError,
  type Context,
} from './kaiten-cli.js';
import { progressLine } from './kaiten-format.js';
import { recordOp, storeBlob } from './store-write.js';

export const WRITE_HELP: Record<string, string> = {
  new: `kaiten new "<заголовок>" — завести задачу.

Задача попадает во «Входящие» без приоритета: его ставят при разборе.
Заголовок — с глагола («Починить…», «Перенести…»). «Суть» — 1–3 предложения
для фаундера без терминов кода. Без --stdin тело задачи — пустой скелет по
типу; заполнить его — kaiten edit.

Флаги:
  --type <тип>        обязательно: ${TASK_TYPES.join(', ')}
  --summary <текст>   обязательно: «Суть»
  --epic <задача>     эпик, в который входит задача
  --slug <имя>        короткое имя латиницей через дефис (по умолчанию — из заголовка)
  --agent             задачу заводит агент
  --stdin             тело задачи — из стандартного ввода

Пример:
  kaiten new "Починить повтор вебхука после 503" --type bug --agent \\
    --summary "Оплата теряется, если база ответила ошибкой." --epic PRJ-100
`,
  check: `kaiten check <задача> <пункт>... — отметить пункты задачи.

Пункт — его текст или слова, по которым он находится однозначно; обратные
кавычки в тексте пункта можно не писать. Можно несколько пунктов за раз:
однозначные отмечаются, про остальные команда говорит, что не так, и
завершается с ошибкой. Команда называет отмеченные пункты и счёт по разделам.
${TASK_REF_HELP}

Флаги:
  --off               снять отметку

Пример:
  kaiten check PRJ-123 'тест на таймаут' 'ретраи'
`,
  attach: `kaiten attach <задача> <файл> — приложить файл к задаче.

Отчёт, передача дел, схема, данные — всё, что относится к задаче, но не
постановка. Файл с таким именем у задачи заменяется. Читать вложения —
kaiten files <задача>.
${TASK_REF_HELP}

Флаги:
  --as <имя>          имя вложения (по умолчанию — имя файла)
  --stdin             содержимое — из стандартного ввода; тогда второй
                      аргумент — имя вложения

Примеры:
  kaiten attach PRJ-123 report.pdf
  kaiten attach PRJ-123 tmp/notes.md --as HANDOFF.md
  kaiten attach PRJ-123 HANDOFF.md --stdin <<'EOF'
  …текст…
  EOF
`,
  log: `kaiten log <задача> "<текст>" — запись в журнал задачи.

Что сделано, что выяснилось, что мешает. Первая строка — заголовок записи.

Флаги:
  --stdin             текст — из стандартного ввода

Пример:
  kaiten log PRJ-123 "Воспроизвёл на staging: причина в ретраях"
`,
  block: `kaiten block <задача> --reason "<что мешает>" — задача заблокирована.

Флаги:
  --reason <текст>    обязательно: что блокирует задачу

Пример:
  kaiten block PRJ-123 --reason "ждём доступ к кабинету платёжный сервис"
`,
  cancel: `kaiten cancel <задача> --reason "<почему>" — отменить задачу.

Отменить можно задачу, которая ещё не в работе: во «Входящих», «Бэклоге»
или «Готово к работе». Удалить задачу нельзя — только отменить.

Флаги:
  --reason <текст>    обязательно: почему задача не нужна

Пример:
  kaiten cancel PRJ-130 --reason "дубль PRJ-123"
`,
  review: `kaiten review <задача> — работа готова, задача на ревью.

Из «В работе», когда критерии задачи отмечены. Эпик так не закрывают: его
закрывают в Kaiten, когда закрыты его задачи.

Флаги:
  --note <текст>      что смотреть на ревью (ветка, коммит, PR) — в журнал
  --unchecked <текст> почему часть критериев осталась без отметки — в журнал;
                      без этого флага задача с неотмеченными критериями на
                      ревью не уходит

Пример:
  kaiten review PRJ-123 --note "PR #45"
`,
  done: `kaiten done <задача> — задача сделана (влито в прод).

Из «Ревью». Задача уходит в архив, в «Сделано».

Флаги:
  --note <текст>      что влито и куда — в журнал

Пример:
  kaiten done PRJ-123 --note "влито в main, выкатано"
`,
  edit: `kaiten edit <задача> — поправить текст задачи.

Открывает задачу в вашем редакторе; после сохранения задача проверяется и
записывается. Меняются заголовок, «Суть», постановка, репозиторий, эпик и
связи; статус, приоритет, исполнитель и сроки меняются в Kaiten.

Флаги:
  --stdin             новый текст задачи целиком — из стандартного ввода
                      (текущий: kaiten show <задача> --raw)

Примеры:
  kaiten edit PRJ-123
  kaiten edit PRJ-123 --stdin <<'EOF'
  ---
  …весь текст задачи из kaiten show PRJ-123 --raw, с правками…
  EOF
`,
};

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

/** Записать операцию и сказать, что получилось. */
export async function commit(ctx: Context, op: Op, what: string): Promise<void> {
  const result = recordOp(ctx.store, op, what, today());
  if ('error' in result) throw new UsageError(`Не записано: ${result.error}`, 1);
  const first = result.summary.charAt(0).toUpperCase() + result.summary.slice(1);
  console.log(result.changed ? `${first}.` : `${first} — менять нечего.`);
  for (const w of result.warnings) console.log(`  подсказка: ${w}`);
  if (!result.changed) return;
  refreshLocalCopy(ctx);
  await startSend(ctx);
}

function begin(): Context {
  const ctx = resolveContext();
  printNotices(ctx);
  return ctx;
}

function taskArg(positionals: string[], command: string): string {
  if (positionals.length === 0) throw new UsageError(`Укажите задачу: kaiten ${command} PRJ-123`);
  return positionals[0];
}

async function newTask(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    'new',
    args,
    { type: { type: 'string' }, summary: { type: 'string' }, epic: { type: 'string' }, slug: { type: 'string' }, agent: { type: 'boolean' }, stdin: { type: 'boolean' } },
    1,
  );
  const title = positionals[0]?.trim();
  if (!title) throw new UsageError('Укажите заголовок: kaiten new "Починить…" --type bug --summary "…"');
  const type = stringFlag(values, 'type');
  if (!type || !(TASK_TYPES as readonly string[]).includes(type)) throw new UsageError(`--type: укажите тип задачи: ${TASK_TYPES.join(', ')}`);
  const summary = stringFlag(values, 'summary')?.trim();
  if (!summary) throw new UsageError('--summary: без «Сути» задачу не завести — 1–3 предложения для фаундера.');

  const ctx = begin();
  const { index } = loadTasks(ctx);
  let epic: string | undefined;
  const epicRef = stringFlag(values, 'epic');
  if (epicRef) {
    if (type === 'epic') throw new UsageError('--epic: у эпика не бывает эпика — уровней два.');
    const found = findTask(index, epicRef);
    if (found.fm.type !== 'epic') throw new UsageError(`--epic: ${epicRef} — не эпик, а ${found.fm.type}.`);
    epic = found.fm.tracker ?? found.fm.id;
  }

  const taken = new Set(index.tasks.map((t) => t.slug));
  for (const p of index.problems) taken.add(p.path.split('/').at(-1)?.replace(/\.md$/, '') ?? '');
  const wanted = stringFlag(values, 'slug')?.trim() ?? slugify(title);
  if (!wanted || !SLUG_RE.test(wanted)) throw new UsageError('--slug: короткое имя латиницей через дефис, например fix-webhook-retry.');
  if (stringFlag(values, 'slug') && taken.has(wanted)) throw new UsageError(`--slug: задача ${wanted} уже есть — выберите другое имя.`);
  const slug = uniqueSlug(wanted, taken);

  const text = newTaskText(
    {
      id: ulid(),
      slug,
      title,
      summary,
      type: type as TaskType,
      repo: type === 'epic' ? undefined : ctx.currentRepo,
      epic,
      createdBy: currentPerson(),
      createdVia: values.agent ? 'agent' : 'human',
      body: values.stdin ? readStdin() : undefined,
    },
    today(),
  );
  if (typeof text !== 'string') throw new UsageError(`Не записано: ${text.error}`, 1);
  await commit(ctx, { kind: 'new', path: `active/${slug}.md`, text }, `новая задача ${slug}`);
  console.log(`Открыть: kaiten show ${slug}`);
}

async function check(args: string[]): Promise<void> {
  const { values, positionals } = parse('check', args, { off: { type: 'boolean' } });
  const ref = taskArg(positionals, 'check');
  const queries = positionals.slice(1);
  if (queries.length === 0) throw new UsageError('Укажите пункт: kaiten check PRJ-123 "тест на таймаут"');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  // Каждая фраза — сама по себе: однозначные отмечаются, спорные называются. Раньше одна спорная
  // фраза отклоняла всю команду, и агент уходил дальше с нулём отметок (испытание 30.09).
  const items: string[] = [];
  const missed: string[] = [];
  for (const q of queries) {
    const hit = matchItem(task.body, q);
    if ('error' in hit) missed.push(q);
    else if (!items.includes(hit.item)) items.push(hit.item);
  }
  if (items.length > 0) {
    await commit(ctx, { kind: 'check', id: task.fm.id, items, checked: !values.off }, `${values.off ? 'снятие' : 'отметка'} пунктов в ${refOf(task)}`);
    for (const item of items) console.log(`  [${values.off ? ' ' : 'x'}] ${item}`);
  }
  const after = loadTasks(ctx).index.tasks.find((t) => t.fm.id === task.fm.id);
  const progress = after ? progressLine(after) : null;
  if (progress) console.log(progress);
  // Причины — по состоянию после отметок: в списке неотмеченного не должно быть только что отмеченного.
  const problems = missed.map((q) => matchItem((after ?? task).body, q)).flatMap((hit) => ('error' in hit ? [hit.error] : []));
  if (problems.length > 0) {
    const done = items.length > 0 ? `Отмечены не все: фраз без отметки — ${problems.length} из ${queries.length}.` : 'Ничего не отмечено: ни одна фраза не подошла однозначно.';
    throw new UsageError(`${done}\n${problems.map((p) => `В задаче ${refOf(task)} ${p}`).join('\n')}`, 1);
  }
}

async function attach(args: string[]): Promise<void> {
  const { values, positionals } = parse('attach', args, { as: { type: 'string' }, stdin: { type: 'boolean' } }, 2);
  const ref = taskArg(positionals, 'attach');
  const source = positionals[1];
  if (!source) throw new UsageError(values.stdin ? 'Укажите имя вложения: kaiten attach PRJ-123 HANDOFF.md --stdin' : 'Укажите файл: kaiten attach PRJ-123 report.md');
  let name: string;
  let content: Buffer;
  if (values.stdin) {
    name = stringFlag(values, 'as')?.trim() ?? source;
    content = readFileSync(0);
  } else {
    const path = resolve(source);
    if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`Нет файла ${source}.`, 1);
    name = stringFlag(values, 'as')?.trim() ?? basename(path);
    content = readFileSync(path);
  }
  name = name.replaceAll('\\', '/');
  const problem = attachmentNameProblem(name);
  if (problem) throw new UsageError(`Имя вложения «${name}» не годится: ${problem}.`);
  if (content.length === 0) throw new UsageError('Файл пуст — прикладывать нечего.', 1);
  if (content.length > ATTACHMENT_MAX_BYTES) {
    throw new UsageError(`Файл больше ${ATTACHMENT_MAX_BYTES / 1024 / 1024} МБ — такие к задаче не прикладываются: положите его в общее хранилище файлов и дайте ссылку в задаче.`, 1);
  }
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  let blob: string;
  try {
    blob = storeBlob(ctx.store, content);
  } catch {
    throw new UsageError('Не записано: вложение не сохранить. Повторите kaiten pull; если не поможет — сообщите тому, кто настраивал kaiten.', 1);
  }
  await commit(ctx, { kind: 'attach', id: task.fm.id, name, blob }, `вложение ${name} задачи ${refOf(task)}`);
  console.log(`Прочитать: kaiten files ${refOf(task)} ${name}`);
}

async function log(args: string[]): Promise<void> {
  const { values, positionals } = parse('log', args, { stdin: { type: 'boolean' } }, 2);
  const ref = taskArg(positionals, 'log');
  const text = values.stdin ? readStdin() : positionals[1];
  if (!text?.trim()) throw new UsageError('Укажите текст: kaiten log PRJ-123 "что сделано"');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  await commit(ctx, { kind: 'log', id: task.fm.id, text }, `запись в журнал ${refOf(task)}`);
}

async function withReason(command: 'block' | 'cancel', args: string[]): Promise<void> {
  const { values, positionals } = parse(command, args, { reason: { type: 'string' } }, 1);
  const ref = taskArg(positionals, command);
  const reason = stringFlag(values, 'reason')?.trim();
  if (!reason) throw new UsageError(`--reason: ${command === 'block' ? 'что блокирует задачу' : 'почему задача не нужна'}.`);
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const what = command === 'block' ? `блокировка ${refOf(task)}` : `отмена ${refOf(task)}`;
  // Проверить у себя до карточки: карточку не двигаем, если задачу всё равно не записать.
  const allowed = command === 'block' ? BLOCKABLE : CANCELLABLE;
  if (!allowed.includes(task.fm.status)) {
    const hint = command === 'block' ? 'заблокировать можно только открытую' : `отменить можно только из ${CANCELLABLE.join(', ')}`;
    throw new UsageError(`Не записано: задача ${refOf(task)} в статусе ${task.fm.status}: ${hint}`, 1);
  }
  const card = await moveCardFirst(ctx, task, command === 'block' ? 'blocked' : 'cancelled');
  await commit(ctx, { kind: command, id: task.fm.id, reason }, what);
  cardNotMovedNote(card);
}

async function move(command: 'review' | 'done', args: string[]): Promise<void> {
  const { values, positionals } = parse(command, args, { note: { type: 'string' }, ...(command === 'review' ? { unchecked: { type: 'string' as const } } : {}) }, 1);
  const ref = taskArg(positionals, command);
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const status = command === 'review' ? 'review' : 'done';
  const problem = moveProblem(task, status);
  if (problem) throw new UsageError(`Не записано: ${problem}.`, 1);
  // На ревью — с отмеченными критериями: неотмеченный пункт либо не сделан, либо о нём надо сказать словами.
  const why = stringFlag(values, 'unchecked')?.trim();
  const open = command === 'review' && task.fm.status !== 'review' ? openCriteria(task.body) : [];
  if (open.length > 0 && !why) {
    throw new UsageError(
      `Не записано: в задаче ${refOf(task)} неотмеченные критерии (${open.length}):\n${open.map((i) => `  - ${i}`).join('\n')}\n` +
        `Сделанное отметьте: kaiten check ${refOf(task)} '<слова пункта>'. Пункт не будет сделан в этой работе — скажите почему: kaiten review ${refOf(task)} --unchecked "<причина>".`,
      1,
    );
  }
  const note = [stringFlag(values, 'note')?.trim(), open.length > 0 && why ? `не отмечено пунктов ${open.length}: ${why}` : undefined].filter(Boolean).join('; ') || undefined;
  const card = task.fm.status !== status ? await moveCardFirst(ctx, task, status) : 'none';
  await commit(ctx, { kind: 'move', id: task.fm.id, status, note }, `${command === 'review' ? 'ревью' : 'закрытие'} ${refOf(task)}`);
  cardNotMovedNote(card);
}

/** Неотмеченные пункты раздела критериев (первый заголовок на «Критери…»); шаги и прочие списки не считаются. */
export function openCriteria(body: string): string[] {
  return (criteriaText(body) ?? '')
    .split('\n')
    .map((line) => /^\s*(?:[-*+]|\d+[.)])[ \t]+\[ \][ \t]+(\S.*)$/.exec(line)?.[1].trim())
    .filter((text): text is string => text !== undefined);
}

/** Текст задачи для правки — канонический: так его и запишет любая команда. */
export function editableText(task: TaskRecord): string {
  return serializeTaskDocument(task.fm, task.body);
}

function editorCommand(): string {
  return process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi');
}

async function edit(args: string[]): Promise<void> {
  const { values, positionals } = parse('edit', args, { stdin: { type: 'boolean' } }, 1);
  const ref = taskArg(positionals, 'edit');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const baseHash = contentHash(task.fm, task.body);
  const what = `правка ${refOf(task)}`;

  if (values.stdin) {
    await commit(ctx, { kind: 'edit', id: task.fm.id, text: readStdin(), baseHash }, what);
    return;
  }

  // Черновик во временной папке — не в репозитории кода.
  const draft = join(tmpdir(), `kaiten-${task.slug}.md`);
  const original = editableText(task);
  writeFileSync(draft, original);
  let previous = original;
  for (;;) {
    const run = spawnSync(`${editorCommand()} "${draft}"`, { shell: true, stdio: 'inherit' });
    if (run.status !== 0) throw new UsageError(`Редактор завершился с ошибкой. Черновик: ${draft}`, 1);
    const text = readFileSync(draft, 'utf8');
    if (text === original) {
      console.log('Без изменений.');
      return;
    }
    if (text === previous && previous !== original) throw new UsageError(`Правка не записана. Черновик: ${draft}`, 1);
    const result = recordOp(ctx.store, { kind: 'edit', id: task.fm.id, text, baseHash }, what, today());
    if (!('error' in result)) {
      console.log(`${result.summary.charAt(0).toUpperCase()}${result.summary.slice(1)}.`);
      for (const w of result.warnings) console.log(`  подсказка: ${w}`);
      if (result.changed) {
        refreshLocalCopy(ctx);
        await startSend(ctx);
      }
      return;
    }
    console.error(`Не записано: ${result.error}\nИсправьте в редакторе и сохраните; закройте без изменений — чтобы бросить правку.`);
    previous = text;
  }
}

export const WRITE_COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  new: newTask,
  check,
  attach,
  log,
  block: (args) => withReason('block', args),
  cancel: (args) => withReason('cancel', args),
  review: (args) => move('review', args),
  done: (args) => move('done', args),
  edit,
};

