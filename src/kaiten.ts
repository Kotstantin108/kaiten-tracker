/**
 * CLI `kaiten` — команды чтения: `list`, `show`, `search`, `files`, `pull`,
 * и `export` — копия задач для людей.
 *
 * Для кого. Для агента и разработчика в репозитории кода. `--help` и
 * сообщения говорят только, что делает команда, её аргументы и пример;
 * устройство описано здесь и в README, но не в выводе (решение владельца
 * 25.09.2026). Решение 28.09.2026: CLI — единственный путь к задачам, поэтому
 * вывод никогда не называет, где задачи лежат: ни путь хранилища, ни сырые
 * ошибки git (в них пути), ни трассировку стека.
 *
 * Как устроено.
 *   · Задачи — в хранилище без рабочей копии (`task-store.ts`): файлов задач
 *     на диске нет. Команды чтения работают без сети (Q10) и Kaiten не
 *     трогают. Сверки перед чтением пока нет — она пишет и пушит, поэтому
 *     придёт с командами записи.
 *   · `pull` клонирует по `tasksRepo.url` или забирает свежее и перематывает
 *     ветку вперёд.
 *   · `export` — копия для чтения в папку, которую выбрал человек (не в
 *     репозиторий git); правки в ней никуда не уходят.
 *   · Проект: `--project`, `KAITEN_PROJECT`, иначе по репозиторию, из
 *     которого запущена команда (имя из `origin`, без него — имя папки
 *     верхнего уровня), иначе единственный проект конфига.
 *   · Конфиг — `tracker.config.json` рядом с инструментом, не в текущей
 *     папке. `KAITEN_CONFIG` и `KAITEN_STORE` подменяют конфиг и хранилище
 *     (тесты, пробные прогоны); в сообщениях они не упоминаются.
 *
 * Коды выхода: 0 — ок; 1 — задача не найдена или обновить не удалось;
 * 2 — ошибка аргументов, проекта или отсутствующих задач; 3 — внутренняя
 * ошибка (подробности — с `KAITEN_DEBUG=1`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { loadConfig, loadProject, type LoadedProject } from './config.js';
import { STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from './core/schema.js';
import {
  belongsToProject,
  buildIndex,
  filterTasks,
  refOf,
  resolveTask,
  searchTasks,
  sortTasks,
  type TaskFilter,
  type TaskIndex,
  type TaskRecord,
} from './core/tasks-index.js';
import { formatSearch, formatShow, formatTaskLines, showJson, taskJson } from './kaiten-format.js';
import {
  cloneStore,
  defaultStorePath,
  exportStore,
  isStore,
  listEntries,
  readBlobs,
  readStoreTree,
  StoreError,
  updateStore,
  type StoreEntry,
} from './task-store.js';

class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

const CONFIG_PATH = process.env.KAITEN_CONFIG ?? fileURLToPath(new URL('../tracker.config.json', import.meta.url));

function projectKeys(): string[] {
  return Object.keys(loadConfig(CONFIG_PATH).projects);
}

// ── справка ──────────────────────────────────────────────────────────────

const TASK_REF_HELP = 'Задача — ключ карточки (PRJ-123 или 10000002), id или slug.';

function mainHelp(): string {
  return `kaiten — задачи проекта: посмотреть, найти, обновить.

Команды:
  kaiten list                    задачи продукта, в репозитории которого вы находитесь
  kaiten show <задача>           задача целиком: постановка, пункты, журнал, эпик
  kaiten search <слова>          найти задачи по словам
  kaiten files <задача> [файл]   вложения задачи
  kaiten pull                    получить свежие задачи проекта
  kaiten export <папка>          копия задач в папку — читать в своём редакторе

${TASK_REF_HELP}
Проект определяется по репозиторию, из которого запущена команда.
Вне его — флаг --project (${projectKeys().join(', ')}).

Подробно о команде: kaiten <команда> --help
`;
}

const PROJECT_HELP = '  --project <имя>     проект, если команда запущена не из его репозитория';

const FILTER_HELP = `  --repo <имя>        только задачи этого репозитория
  --epic <задача>     только задачи эпика
  --status <список>   статусы через запятую: ${STATUSES.join(', ')}
  --type <список>     типы через запятую: ${TASK_TYPES.join(', ')}
  --json              вывод в JSON
${PROJECT_HELP}`;

const HELP: Record<string, string> = {
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
${PROJECT_HELP}

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
${PROJECT_HELP}

Примеры:
  kaiten files PRJ-123
  kaiten files PRJ-123 RESEARCH.md
`,
  pull: `kaiten pull — получить свежие задачи проекта на эту машину.

Нужен перед работой, если задачи давно не обновлялись. Первый запуск
загружает задачи проекта целиком.

Флаги:
${PROJECT_HELP}

Пример:
  kaiten pull
`,
  export: `kaiten export <папка> — копия задач проекта для чтения в своём редакторе.

Для людей, которым удобнее папки и файлы: active/ — открытые задачи,
archive/ — закрытые по месяцам, attachments/ — вложения. Повторный запуск
обновляет копию. Файлы копии — только для чтения: правки в ней никуда не
уходят. Папка — пустая или прошлая копия, и не внутри репозитория git.

Флаги:
  --force             перезаписать и файлы, изменённые в копии вручную
${PROJECT_HELP}

Пример:
  kaiten export D:/tasks/acme
`,
};

// ── контекст: проект, продукт, задачи ────────────────────────────────────

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Имя репозитория кода, из которого запущена команда: по `origin`, без него — по папке верхнего уровня. */
function currentRepoNames(cwd: string): string[] {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return [];
  const names: string[] = [];
  const origin = git(cwd, ['remote', 'get-url', 'origin']);
  if (origin) names.push(basename(origin.replace(/[\\/]+$/, '')).replace(/\.git$/, ''));
  names.push(basename(top));
  return names;
}

interface Context {
  loaded: LoadedProject;
  title: string;
  /** Репозиторий кода проекта, из которого запущена команда. */
  currentRepo: string | null;
  store: string;
}

function resolveContext(projectFlag: string | undefined): Context {
  const names = currentRepoNames(process.cwd());
  const keys = projectKeys();
  let key = projectFlag ?? process.env.KAITEN_PROJECT ?? null;
  let currentRepo: string | null = null;

  if (!key) {
    const { projects } = loadConfig(CONFIG_PATH);
    for (const k of keys) {
      const hit = names.find((n) => projects[k].repos.some((r) => r.name === n));
      if (hit) {
        key = k;
        currentRepo = hit;
        break;
      }
    }
  }
  if (!key && keys.length === 1) key = keys[0];
  if (!key) throw new UsageError(`Не понял, какой это проект. Запустите команду из репозитория проекта или укажите --project (${keys.join(', ')}).`);
  if (!keys.includes(key)) throw new UsageError(`Проекта «${key}» нет. Есть: ${keys.join(', ')}.`);

  const loaded = loadProject(CONFIG_PATH, key);
  if (!currentRepo) currentRepo = names.find((n) => loaded.project.repos.some((r) => r.name === n)) ?? null;
  const store = defaultStorePath(loaded.project.tasksRepo?.name ?? `${key}-tasks`);
  return { loaded, title: loaded.project.title, currentRepo, store };
}

interface Loaded {
  index: TaskIndex;
  entries: StoreEntry[];
}

function loadTasks(ctx: Context): Loaded {
  if (!existsSync(ctx.store)) throw new UsageError(`Задач проекта ${ctx.title} на этой машине ещё нет. Получите их: kaiten pull`);
  if (!isStore(ctx.store)) throw new StoreError('not-store');
  const entries = listEntries(ctx.store);
  const tree = readStoreTree(ctx.store, entries);
  const index = buildIndex(tree.files, tree.logs);
  if (!belongsToProject(index.tasks, ctx.loaded.project.repos.map((r) => r.name))) {
    throw new UsageError(`Задачи на этой машине — другого проекта, не ${ctx.title}. Укажите --project.`);
  }
  return { index, entries };
}

function attachmentsOf(entries: readonly StoreEntry[], task: TaskRecord): StoreEntry[] {
  const prefix = `attachments/${task.slug}/`;
  return entries.filter((e) => e.path.startsWith(prefix));
}

function attachmentName(entry: StoreEntry, task: TaskRecord): string {
  return entry.path.slice(`attachments/${task.slug}/`.length);
}

function reportProblems(index: TaskIndex): void {
  if (index.problems.length === 0) return;
  const shown = index.problems.slice(0, 5);
  console.error(`\nНе читается задач: ${index.problems.length}. Что исправить:`);
  for (const p of shown) console.error(`  ${p.path}: ${p.message}`);
  if (index.problems.length > shown.length) console.error(`  …и ещё ${index.problems.length - shown.length}`);
}

// ── флаги ────────────────────────────────────────────────────────────────

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | undefined>;

const COMMON: Options = { project: { type: 'string' }, help: { type: 'boolean', short: 'h' } };
const FILTERS: Options = {
  repo: { type: 'string' },
  epic: { type: 'string' },
  status: { type: 'string' },
  type: { type: 'string' },
  json: { type: 'boolean' },
};

/** Ошибки `parseArgs` приходят по-английски — переводим частые. */
function flagError(error: unknown): string {
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const flag = /'([^']+)'/.exec(message)?.[1] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Нет флага ${flag}.`;
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return `Флагу ${flag.split(' ')[0]} нужно значение.`;
  return message;
}

function parse(command: string, args: string[], options: Options, maxPositionals = Infinity): { values: Values; positionals: string[] } {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${flagError(error)}\nСправка: kaiten ${command} --help`);
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`Лишний аргумент: ${parsed.positionals.slice(maxPositionals).join(' ')}\nСправка: kaiten ${command} --help`);
  }
  return { values: parsed.values as Values, positionals: parsed.positionals };
}

function projectFlag(values: Values): string | undefined {
  return typeof values.project === 'string' ? values.project : undefined;
}

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

function findTask(index: TaskIndex, ref: string): TaskRecord {
  const found = resolveTask(index.tasks, ref);
  if ('error' in found) {
    const broken = index.problems.find((p) => p.path.endsWith(`/${ref}.md`));
    throw new UsageError(broken ? `Задача ${ref} не читается: ${broken.message}` : found.error, 1);
  }
  return found.task;
}

// ── команды ──────────────────────────────────────────────────────────────

function list(args: string[]): void {
  const { values } = parse('list', args, { ...FILTERS, all: { type: 'boolean' }, closed: { type: 'boolean' } }, 0);
  const ctx = resolveContext(projectFlag(values));
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
    if (!scope && !values.all && !ctx.currentRepo) console.log('\nКоманда запущена не из репозитория продукта — показан весь проект.');
  }
  reportProblems(index);
}

function show(args: string[]): void {
  const { values, positionals } = parse('show', args, { json: { type: 'boolean' } }, 1);
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten show PRJ-123');
  const ctx = resolveContext(projectFlag(values));
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, positionals[0]);
  const attachments = attachmentsOf(entries, task).map((e) => attachmentName(e, task));
  if (values.json) console.log(JSON.stringify(showJson(index.tasks, task, attachments), null, 2));
  else process.stdout.write(formatShow(index.tasks, task, attachments));
}

function search(args: string[]): void {
  const { values, positionals } = parse('search', args, FILTERS);
  if (positionals.length === 0) throw new UsageError('Укажите слова для поиска: kaiten search таймаут вебхук');
  const ctx = resolveContext(projectFlag(values));
  const { index } = loadTasks(ctx);
  const filter = { ...buildFilter(ctx, index, values), closed: true };
  const hits = searchTasks(filterTasks(index.tasks, filter), positionals.join(' '));
  if (values.json) {
    console.log(JSON.stringify(hits.map((h) => ({ ...taskJson(index.tasks, h.task), snippet: h.snippet })), null, 2));
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
  const ctx = resolveContext(projectFlag(values));
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

function pull(args: string[]): void {
  const { values } = parse('pull', args, {}, 0);
  const ctx = resolveContext(projectFlag(values));
  let changed = true;
  if (!existsSync(ctx.store)) {
    const url = ctx.loaded.project.tasksRepo?.url;
    if (!url) throw new UsageError(`Задачи проекта ${ctx.title} ещё негде взять: хранилище задач не подключено. Это вопрос к владельцу проекта.`);
    cloneStore(url, ctx.store);
  } else {
    changed = updateStore(ctx.store);
  }
  const { index } = loadTasks(ctx);
  const open = index.tasks.filter((t) => !t.closed).length;
  console.log(`Задачи проекта ${ctx.title} ${changed ? 'обновлены' : 'уже свежие'}: открытых ${open}, всего ${index.tasks.length}.`);
  reportProblems(index);
}

function exportCommand(args: string[]): void {
  const { values, positionals } = parse('export', args, { force: { type: 'boolean' } }, 1);
  if (positionals.length === 0) throw new UsageError('Укажите папку для копии: kaiten export D:/tasks/acme');
  const ctx = resolveContext(projectFlag(values));
  const { entries } = loadTasks(ctx);
  const target = resolve(positionals[0]);
  const result = exportStore(ctx.store, entries, target, ctx.loaded.key, values.force === true);
  if (result.refused === 'foreign-folder') throw new UsageError(`Папка ${target} не пуста и не похожа на копию задач. Укажите пустую или новую папку.`);
  if (result.refused === 'inside-repo') throw new UsageError(`Папка ${target} внутри репозитория git. Копию задач держат вне репозиториев — укажите другую папку.`);
  if (result.refused === 'other-project') throw new UsageError(`В папке ${target} копия задач другого проекта. Укажите другую папку.`);

  console.log(`Копия задач проекта ${ctx.title} в ${target}: обновлено файлов ${result.written}, удалено ${result.removed}.`);
  console.log('Файлы копии — только для чтения: правки в ней никуда не уходят.');
  if (result.modified.length > 0) {
    console.log(`\nИзменены в копии вручную и не перезаписаны (${result.modified.length}):`);
    for (const p of result.modified.slice(0, 10)) console.log(`  ${p}`);
    if (result.modified.length > 10) console.log(`  …и ещё ${result.modified.length - 10}`);
    console.log(`Вернуть как в задачах: kaiten export ${positionals[0]} --force`);
  }
}

const COMMANDS: Record<string, (args: string[]) => void> = { list, show, search, files, pull, export: exportCommand };

function storeMessage(error: StoreError): string {
  switch (error.kind) {
    case 'no-access':
      return 'Нет доступа к задачам проекта. Попросите владельца проекта добавить вас в команду проекта на GitHub.';
    case 'offline':
      return 'Не удалось связаться с хранилищем задач. Проверьте интернет и повторите.';
    case 'not-found':
      return 'Хранилище задач проекта не найдено. Это вопрос к владельцу проекта.';
    case 'diverged':
      return 'Задачи на этой машине разошлись с общими. Сообщите тому, кто настраивал kaiten.';
    default:
      return 'Задачи проекта на этой машине недоступны. Повторите kaiten pull; если не поможет — сообщите тому, кто настраивал kaiten.';
  }
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
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
  run(args);
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(error.code);
  }
  if (error instanceof StoreError) {
    console.error(storeMessage(error));
    process.exit(1);
  }
  // Трассировка стека называет пути хранилища и исходников — только по запросу.
  if (process.env.KAITEN_DEBUG) console.error(error);
  console.error('kaiten: внутренняя ошибка. Повторите команду; если повторяется — сообщите тому, кто настраивал kaiten.');
  process.exit(3);
}
