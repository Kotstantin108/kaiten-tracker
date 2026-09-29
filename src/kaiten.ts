/**
 * CLI `kaiten` — задачи проекта для агента и разработчика. Точка входа:
 * справка, команды чтения (`list`, `show`, `search`, `files`, `pull`) и
 * разводка на команды записи (`kaiten-write.ts`).
 *
 * Для кого. `--help` и сообщения говорят только, что делает команда, её
 * аргументы и пример; устройство описано здесь и в README, но не в выводе
 * (решение владельца 25.09.2026). Решение 28.09.2026: CLI — единственный путь
 * к задачам, поэтому вывод никогда не называет, где задачи лежат: ни путь
 * хранилища, ни сырые ошибки git (в них пути), ни трассировку стека.
 *
 * Как устроено.
 *   · Задачи — в хранилище без рабочей копии (`task-store.ts`): файлов задач
 *     на диске нет. Команды чтения работают без сети (Q10) и Kaiten не
 *     трогают.
 *   · Запись — операцией в журнал хранилища с мгновенным локальным коммитом;
 *     общим её отправляет фоновый процесс (`store-write.ts`, скрытая команда
 *     `__send`). `pull` забирает общее и отправляет неотправленное сразу.
 *   · Проект и продукт — только из файла `.kaiten` репозитория кода
 *     (`kaiten-context.ts`); нет файла — репозиторий не подключён.
 *   · Конфиг `tracker.config.json` и настройки `kaiten.settings.json` —
 *     рядом с инструментом. `KAITEN_CONFIG`, `KAITEN_SETTINGS`,
 *     `KAITEN_STORE` и `KAITEN_SEND` (`inline`/`off`) — для тестов и пробных
 *     прогонов; в сообщениях они не упоминаются.
 *
 * Коды выхода: 0 — ок; 1 — задача не найдена, не записано или не отправлено;
 * 2 — ошибка аргументов, проекта или отсутствующих задач; 3 — внутренняя
 * ошибка (подробности — с `KAITEN_DEBUG=1`).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from './core/schema.js';
import { filterTasks, refOf, resolveTask, searchTasks, sortTasks, type TaskFilter, type TaskIndex, type TaskRecord } from './core/tasks-index.js';
import {
  findTask,
  loadTasks,
  parse,
  printNotices,
  sendAll,
  refreshLocalCopy,
  reportProblems,
  resolveContext,
  settings,
  storeMessage,
  syncWithKaiten,
  TASK_REF_HELP,
  UsageError,
  type Context,
  type Options,
  type Values,
} from './kaiten-cli.js';
import { localCopyDir, SettingsError } from './kaiten-context.js';
import { formatSearch, formatShow, formatTaskLines, presentBody, showJson, taskJson } from './kaiten-format.js';
import { START_COMMANDS, START_HELP } from './kaiten-start.js';
import { editableText, WRITE_COMMANDS, WRITE_HELP } from './kaiten-write.js';
import { hasPending, syncStore } from './store-write.js';
import { cloneStore, isStore, readBlobs, StoreError, type StoreEntry } from './task-store.js';

// ── справка ──────────────────────────────────────────────────────────────

function mainHelp(): string {
  return `kaiten — задачи проекта: посмотреть, найти, вести.

Смотреть:
  kaiten list                        задачи продукта, в репозитории которого вы находитесь
  kaiten show <задача>               задача целиком: постановка, пункты, журнал, эпик
  kaiten search <слова>              найти задачи по словам
  kaiten files <задача> [файл]       вложения задачи
  kaiten pull                        получить свежие задачи и отправить свои изменения

Вести:
  kaiten new "<заголовок>" ...       завести задачу
  kaiten check <задача> <пункт>...   отметить пункты
  kaiten log <задача> "<текст>"      запись в журнал задачи
  kaiten block <задача> --reason …   задача заблокирована
  kaiten cancel <задача> --reason …  отменить задачу
  kaiten edit <задача>               поправить текст задачи

Работать:
  kaiten start <задача>              взять в работу: «В работе» и ветка задачи в этом репозитории
  kaiten review <задача>             работа готова — на ревью
  kaiten done <задача>               сделано (влито в прод)

${TASK_REF_HELP}
Команды работают в репозитории, подключённом к kaiten: проект и продукт
берутся из него.

Подробно о команде: kaiten <команда> --help
`;
}

const FILTER_HELP = `  --repo <имя>        только задачи этого репозитория
  --epic <задача>     только задачи эпика
  --status <список>   статусы через запятую: ${STATUSES.join(', ')}
  --type <список>     типы через запятую: ${TASK_TYPES.join(', ')}
  --json              вывод в JSON`;

const READ_HELP: Record<string, string> = {
  list: `kaiten list — список задач.

По умолчанию — открытые задачи продукта, в репозитории которого вы находитесь.
Эпики показываются, если в этом продукте есть их задачи.

Флаги:
  --all               весь проект, все продукты
  --closed            показать и закрытые (done, cancelled)
${FILTER_HELP}

Примеры:
  kaiten list
  kaiten list --all --epic PRJ-100
  kaiten list --status ready,in-progress
`,
  show: `kaiten show <задача> — задача целиком.

Заголовок, «Суть», статус, приоритет, исполнитель и срок, постановка с
пунктами, журнал; для задачи — её эпик и соседние задачи, для эпика — все его
задачи. Ссылки на другие задачи и вложения показаны командами kaiten.
${TASK_REF_HELP}

Флаги:
  --json              вывод в JSON
  --raw               текст задачи целиком — для kaiten edit --stdin

Пример:
  kaiten show PRJ-123
`,
  search: `kaiten search <слова> — найти задачи по словам.

Ищет во всём проекте, в открытых и закрытых задачах: заголовок, «Суть»,
постановка, журнал. Задача подходит, если в ней есть все слова; регистр и
«ё»/«е» не важны.

Флаги:
${FILTER_HELP}

Примеры:
  kaiten search таймаут вебхук
  kaiten search оплата --status done
`,
  files: `kaiten files <задача> [файл] — вложения задачи.

Без имени файла — список вложений. С именем — текстовый файл выводится
целиком, остальные сохраняются во временную папку, и команда называет путь.

Флаги:
  --save              сохранить все вложения во временную папку

Примеры:
  kaiten files PRJ-123
  kaiten files PRJ-123 RESEARCH.md
`,
  pull: `kaiten pull — получить свежие задачи и отправить свои изменения.

Свои изменения kaiten отправляет сам, сразу после команды; pull нужен перед
работой, если задачи давно не обновлялись, или если kaiten сообщил, что
изменения не отправлены. Первый запуск загружает задачи проекта целиком.

Пример:
  kaiten pull
`,
};

const HELP: Record<string, string> = { ...READ_HELP, ...WRITE_HELP, start: START_HELP };

// ── чтение ───────────────────────────────────────────────────────────────

const FILTERS: Options = {
  repo: { type: 'string' },
  epic: { type: 'string' },
  status: { type: 'string' },
  type: { type: 'string' },
  json: { type: 'boolean' },
};

function listOf<T extends string>(raw: string | boolean | undefined, allowed: readonly T[], flag: string): T[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.filter((s) => !(allowed as readonly string[]).includes(s));
  if (bad.length > 0) throw new UsageError(`--${flag}: нет значения ${bad.join(', ')}. Можно: ${allowed.join(', ')}`);
  return items as T[];
}

function buildFilter(ctx: Context, index: TaskIndex, values: Values): TaskFilter {
  const filter: TaskFilter = {
    statuses: listOf<TaskStatus>(values.status, STATUSES, 'status'),
    types: listOf<TaskType>(values.type, TASK_TYPES, 'type'),
    closed: values.closed === true,
  };
  if (typeof values.repo === 'string') {
    const repos = ctx.loaded.project.repos.map((r) => r.name);
    if (!repos.includes(values.repo)) throw new UsageError(`--repo: в проекте нет «${values.repo}». Есть: ${repos.join(', ')}`);
    filter.repo = values.repo;
  }
  if (typeof values.epic === 'string') {
    const found = resolveTask(index.tasks, values.epic);
    if ('error' in found) throw new UsageError(found.error, 1);
    if (found.task.fm.type !== 'epic') throw new UsageError(`--epic: ${values.epic} — не эпик, а ${found.task.fm.type}`);
    filter.epic = found.task;
  }
  return filter;
}

function readContext(): Context {
  const ctx = resolveContext();
  printNotices(ctx);
  return ctx;
}

function attachmentsOf(entries: readonly StoreEntry[], task: TaskRecord): StoreEntry[] {
  const prefix = `attachments/${task.slug}/`;
  return entries.filter((e) => e.path.startsWith(prefix));
}

function attachmentName(entry: StoreEntry, task: TaskRecord): string {
  return entry.path.slice(`attachments/${task.slug}/`.length);
}

function list(args: string[]): void {
  const { values } = parse('list', args, { ...FILTERS, all: { type: 'boolean' }, closed: { type: 'boolean' } }, 0);
  const ctx = readContext();
  const { index } = loadTasks(ctx);
  const filter = buildFilter(ctx, index, values);
  const scope = filter.repo ?? (values.all ? null : ctx.currentRepo);
  if (scope) filter.repo = scope;

  const tasks = sortTasks(filterTasks(index.tasks, filter));
  if (values.json) {
    console.log(JSON.stringify(tasks.map((t) => taskJson(index.tasks, t)), null, 2));
  } else {
    const where = scope ? `${ctx.title} · ${scope}` : `${ctx.title}, весь проект`;
    const which = filter.statuses?.length ? filter.statuses.join(', ') : filter.closed ? 'все' : 'открытые';
    console.log(`${where} · ${which}: ${tasks.length}\n`);
    if (tasks.length > 0) console.log(formatTaskLines(index.tasks, tasks, !scope).join('\n'));
  }
  reportProblems(index);
}

function show(args: string[]): void {
  const { values, positionals } = parse('show', args, { json: { type: 'boolean' }, raw: { type: 'boolean' } }, 1);
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten show PRJ-123');
  const ctx = readContext();
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, positionals[0]);
  const attachments = attachmentsOf(entries, task).map((e) => attachmentName(e, task));
  if (values.raw) process.stdout.write(editableText(task));
  else if (values.json) console.log(JSON.stringify(showJson(index.tasks, task, attachments), null, 2));
  else process.stdout.write(formatShow(index.tasks, task, attachments));
}

function search(args: string[]): void {
  const { values, positionals } = parse('search', args, FILTERS);
  if (positionals.length === 0) throw new UsageError('Укажите слова для поиска: kaiten search таймаут вебхук');
  const ctx = readContext();
  const { index } = loadTasks(ctx);
  const filter = { ...buildFilter(ctx, index, values), closed: true };
  const hits = searchTasks(filterTasks(index.tasks, filter), positionals.join(' '));
  if (values.json) {
    const snippet = (text: string | null): string | null => (text === null ? null : presentBody(index.tasks, text));
    console.log(JSON.stringify(hits.map((h) => ({ ...taskJson(index.tasks, h.task), snippet: snippet(h.snippet) })), null, 2));
  } else {
    console.log(`${ctx.title} · найдено: ${hits.length}\n`);
    if (hits.length > 0) console.log(formatSearch(index.tasks, hits, true).join('\n'));
  }
  reportProblems(index);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Текст — если в начале нет нулевых байтов: так git отличает двоичные файлы. */
function isText(content: Buffer): boolean {
  return !content.subarray(0, 8000).includes(0);
}

function files(args: string[]): void {
  const { values, positionals } = parse('files', args, { save: { type: 'boolean' } }, 2);
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten files PRJ-123');
  const ctx = readContext();
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, positionals[0]);
  const own = attachmentsOf(entries, task);
  const ref = refOf(task);

  if (positionals.length === 1 && !values.save) {
    if (own.length === 0) {
      console.log(`У задачи ${ref} нет вложений.`);
      return;
    }
    console.log(`Вложения задачи ${ref}: ${own.length}\n`);
    const width = Math.max(...own.map((e) => attachmentName(e, task).length));
    for (const e of own) console.log(`${attachmentName(e, task).padEnd(width)}  ${formatSize(e.size)}`);
    console.log(`\nОткрыть: kaiten files ${ref} <файл>`);
    return;
  }

  const chosen = positionals.length === 2 ? own.filter((e) => attachmentName(e, task) === positionals[1]) : own;
  if (chosen.length === 0) {
    throw new UsageError(own.length === 0 ? `У задачи ${ref} нет вложений.` : `У задачи ${ref} нет вложения «${positionals[1]}». Список: kaiten files ${ref}`, 1);
  }
  const blobs = readBlobs(
    ctx.store,
    chosen.map((e) => e.sha),
  );
  if (chosen.length === 1 && !values.save) {
    const content = blobs.get(chosen[0].sha) ?? Buffer.alloc(0);
    if (isText(content)) {
      process.stdout.write(content);
      return;
    }
  }
  // Копия во временную папку — не в текущую: текущая — это репозиторий кода.
  const dir = mkdtempSync(join(tmpdir(), `kaiten-${task.slug}-`));
  for (const e of chosen) {
    const path = join(dir, attachmentName(e, task));
    // Вложения бывают во вложенных папках (`img/scheme.png`).
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blobs.get(e.sha) ?? Buffer.alloc(0));
  }
  console.log(chosen.length === 1 ? `Сохранено: ${join(dir, attachmentName(chosen[0], task))}` : `Сохранено вложений ${chosen.length} в ${dir}`);
}

async function pull(args: string[]): Promise<void> {
  parse('pull', args, {}, 0);
  const ctx = readContext();
  // Настройки — до загрузки: битые настройки не должны обнаружиться после неё.
  const copyDir = localCopyDir(settings(), ctx.loaded.key);
  // Испорченное хранилище (оборванная загрузка, чужая папка) человек удалить не
  // может: где оно лежит, CLI не говорит. Поэтому `pull` загружает заново —
  // но только если в нём нет неотправленных изменений.
  if (existsSync(ctx.store) && !isStore(ctx.store)) {
    if (hasPending(ctx.store)) throw new StoreError('other');
    rmSync(ctx.store, { recursive: true, force: true });
  }
  let changed = true;
  let sent = 0;
  if (!existsSync(ctx.store)) {
    const url = ctx.loaded.project.tasksRepo?.url;
    if (!url) throw new UsageError(`Задачи проекта ${ctx.title} ещё негде взять: хранилище задач не подключено. Это вопрос к владельцу проекта.`);
    cloneStore(url, ctx.store);
  } else {
    const result = syncStore(ctx.store);
    changed = result.changed;
    sent = result.sent;
    for (const f of result.failed) console.error(`Не применено: ${f.what} — ${f.reason}.`);
  }
  const { index } = loadTasks(ctx);
  const open = index.tasks.filter((t) => !t.closed).length;
  console.log(`Задачи проекта ${ctx.title} ${changed ? 'обновлены' : 'уже свежие'}: открытых ${open}, всего ${index.tasks.length}.`);
  if (sent > 0) console.log(`Отправлено изменений: ${sent}.`);
  reportProblems(index);
  const kaiten = await syncWithKaiten(ctx);
  if (kaiten && kaiten.done > 0) console.log(`Kaiten обновлён: ${kaiten.done}.`);
  for (const e of kaiten?.errors ?? []) console.error(`Kaiten: ${e.what} — ${e.message}.`);
  refreshLocalCopy(ctx, copyDir);
}

/** Скрытая команда: фоновая отправка (git, затем Kaiten), её запускают команды записи. Молчит. */
async function send(): Promise<void> {
  await sendAll(resolveContext());
}

const COMMANDS: Record<string, (args: string[]) => void | Promise<void>> = { list, show, search, files, pull, ...WRITE_COMMANDS, ...START_COMMANDS };

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '__send') {
    await send();
    return;
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const topic = command === 'help' ? args[0] : undefined;
    process.stdout.write(topic && HELP[topic] ? HELP[topic] : mainHelp());
    return;
  }
  const run = COMMANDS[command];
  if (!run) throw new UsageError(`Нет команды «${command}». Список команд: kaiten --help`);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP[command]);
    return;
  }
  await run(args);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(error.code);
  }
  if (error instanceof SettingsError) {
    console.error(`Не читаются ${error.message}`);
    process.exit(2);
  }
  if (error instanceof StoreError) {
    console.error(storeMessage(error.kind));
    process.exit(1);
  }
  // Трассировка стека называет пути хранилища и исходников — только по запросу.
  if (process.env.KAITEN_DEBUG) console.error(error);
  console.error('kaiten: внутренняя ошибка. Повторите команду; если повторяется — сообщите тому, кто настраивал kaiten.');
  process.exit(3);
});
