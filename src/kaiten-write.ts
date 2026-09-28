/**
 * Команды записи CLI `kaiten`: `new`, `check`, `log`, `block`, `cancel`,
 * `edit`. Каждая: проверить задачу → записать операцию локально (журнал +
 * коммит, `store-write.ts`) → обновить копию для чтения → отправить общим в
 * фоне. Агент не ждёт сеть; что не применилось при отправке, скажет
 * следующая команда.
 *
 * Kaiten эти команды пока не трогают: карточки догоняют файлы на этапе
 * синхронизации с Kaiten, и он включается в настройках (AGENTS.md: без явного
 * «да» в живой аккаунт не пишем).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentHash, serializeTaskDocument } from './core/document.js';
import { SLUG_RE } from './core/lint.js';
import { TASK_TYPES, type TaskType } from './core/schema.js';
import { matchItem, newTaskText, slugify, uniqueSlug, type Op } from './core/task-ops.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { ulid } from './core/ulid.js';
import {
  currentPerson,
  findTask,
  loadTasks,
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
import { recordOp } from './store-write.js';

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

Пункт — его текст или слова, по которым он находится однозначно. Можно
несколько пунктов за раз.
${TASK_REF_HELP}

Флаги:
  --off               снять отметку

Пример:
  kaiten check PRJ-123 "тест на таймаут" "ретраи"
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
function commit(ctx: Context, op: Op, what: string): void {
  const result = recordOp(ctx.store, op, what, today());
  if ('error' in result) throw new UsageError(`Не записано: ${result.error}`, 1);
  const first = result.summary.charAt(0).toUpperCase() + result.summary.slice(1);
  console.log(result.changed ? `${first}.` : `${first} — менять нечего.`);
  for (const w of result.warnings) console.log(`  подсказка: ${w}`);
  if (!result.changed) return;
  refreshLocalCopy(ctx);
  startSend(ctx);
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

function newTask(args: string[]): void {
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
  commit(ctx, { kind: 'new', path: `active/${slug}.md`, text }, `новая задача ${slug}`);
  console.log(`Открыть: kaiten show ${slug}`);
}

function check(args: string[]): void {
  const { values, positionals } = parse('check', args, { off: { type: 'boolean' } });
  const ref = taskArg(positionals, 'check');
  const queries = positionals.slice(1);
  if (queries.length === 0) throw new UsageError('Укажите пункт: kaiten check PRJ-123 "тест на таймаут"');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const items: string[] = [];
  const problems: string[] = [];
  for (const q of queries) {
    const hit = matchItem(task.body, q);
    if ('error' in hit) problems.push(hit.error);
    else items.push(hit.item);
  }
  if (problems.length > 0) throw new UsageError(`В задаче ${refOf(task)} ${problems.join('\n')}`, 1);
  commit(ctx, { kind: 'check', id: task.fm.id, items, checked: !values.off }, `${values.off ? 'снятие' : 'отметка'} пунктов в ${refOf(task)}`);
}

function log(args: string[]): void {
  const { values, positionals } = parse('log', args, { stdin: { type: 'boolean' } }, 2);
  const ref = taskArg(positionals, 'log');
  const text = values.stdin ? readStdin() : positionals[1];
  if (!text?.trim()) throw new UsageError('Укажите текст: kaiten log PRJ-123 "что сделано"');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  commit(ctx, { kind: 'log', id: task.fm.id, text }, `запись в журнал ${refOf(task)}`);
}

function withReason(command: 'block' | 'cancel', args: string[]): void {
  const { values, positionals } = parse(command, args, { reason: { type: 'string' } }, 1);
  const ref = taskArg(positionals, command);
  const reason = stringFlag(values, 'reason')?.trim();
  if (!reason) throw new UsageError(`--reason: ${command === 'block' ? 'что блокирует задачу' : 'почему задача не нужна'}.`);
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const what = command === 'block' ? `блокировка ${refOf(task)}` : `отмена ${refOf(task)}`;
  commit(ctx, { kind: command, id: task.fm.id, reason }, what);
}

/** Текст задачи для правки — канонический: так его и запишет любая команда. */
export function editableText(task: TaskRecord): string {
  return serializeTaskDocument(task.fm, task.body);
}

function editorCommand(): string {
  return process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi');
}

function edit(args: string[]): void {
  const { values, positionals } = parse('edit', args, { stdin: { type: 'boolean' } }, 1);
  const ref = taskArg(positionals, 'edit');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const baseHash = contentHash(task.fm, task.body);
  const what = `правка ${refOf(task)}`;

  if (values.stdin) {
    commit(ctx, { kind: 'edit', id: task.fm.id, text: readStdin(), baseHash }, what);
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
        startSend(ctx);
      }
      return;
    }
    console.error(`Не записано: ${result.error}\nИсправьте в редакторе и сохраните; закройте без изменений — чтобы бросить правку.`);
    previous = text;
  }
}

export const WRITE_COMMANDS: Record<string, (args: string[]) => void> = {
  new: newTask,
  check,
  log,
  block: (args) => withReason('block', args),
  cancel: (args) => withReason('cancel', args),
  edit,
};

