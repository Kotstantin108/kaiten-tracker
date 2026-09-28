/**
 * CLI `kaiten` — команды чтения: `list`, `show`, `search`, `pull`.
 *
 * Для кого. Для агента и разработчика в репозитории кода. Поэтому `--help` и
 * сообщения говорят только, что делает команда, её аргументы и пример;
 * устройство (клон репозитория задач, git, Kaiten) описано здесь и в README,
 * но не в выводе (решение владельца 25.09.2026).
 *
 * Как устроено.
 *   · Задачи читаются из локального клона репозитория задач проекта: сеть не
 *     нужна (Q10), Kaiten команды чтения не трогают. Сверки перед чтением
 *     пока нет — она появится вместе с командами записи, потому что пишет и
 *     пушит.
 *   · Клон: `TASKS_DIR` (один клон — один проект, как у `tasks:lint`), иначе
 *     `~/.kaiten/<tasksRepo.name>`. `pull` клонирует по `tasksRepo.url` или
 *     делает `git pull --rebase`; локальные правки мимо CLI его останавливают.
 *   · Проект: `--project`, `KAITEN_PROJECT`, иначе по репозиторию, из
 *     которого запущена команда (имя из `origin`, без него — имя папки
 *     верхнего уровня), иначе единственный проект конфига.
 *   · Конфиг — `tracker.config.json` рядом с инструментом, не в текущей
 *     папке: команду запускают из репозиториев кода. `KAITEN_CONFIG` его
 *     подменяет (тесты, пробные прогоны).
 *
 * Коды выхода: 0 — ок; 1 — задача не найдена или обновить не удалось;
 * 2 — ошибка аргументов, проекта или отсутствующих задач.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { loadConfig, loadProject, type LoadedProject } from './config.js';
import { STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from './core/schema.js';
import { belongsToProject, buildIndex, filterTasks, resolveTask, searchTasks, sortTasks, type TaskFilter, type TaskIndex } from './core/tasks-index.js';
import { formatSearch, formatShow, formatTaskLines, showJson, taskJson } from './kaiten-format.js';
import { readTasksTree } from './tasks-files.js';

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
  kaiten list               задачи продукта, в репозитории которого вы находитесь
  kaiten show <задача>      задача целиком: постановка, пункты, журнал, эпик
  kaiten search <слова>     найти задачи по словам
  kaiten pull               получить свежие задачи проекта

${TASK_REF_HELP}
Проект определяется по репозиторию, из которого запущена команда.
Вне его — флаг --project (${projectKeys().join(', ')}).

Подробно о команде: kaiten <команда> --help
`;
}

const FILTER_HELP = `  --repo <имя>        только задачи этого репозитория
  --epic <задача>     только задачи эпика
  --status <список>   статусы через запятую: ${STATUSES.join(', ')}
  --type <список>     типы через запятую: ${TASK_TYPES.join(', ')}
  --json              вывод в JSON
  --project <имя>     проект, если команда запущена не из его репозитория`;

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
задачи.
${TASK_REF_HELP}

Флаги:
  --json              вывод в JSON
  --project <имя>     проект, если команда запущена не из его репозитория

Пример:
  kaiten show PRJ-123
`,
  search: `kaiten search <слова> — найти задачи по словам.

Ищет во всём проекте, в открытых и закрытых задачах: заголовок, «Суть»,
постановка, журнал. Задача подходит, если в ней есть все слова; регистр и
«ё»/«е» не важны.

Флаги:
${FILTER_HELP}

Пример:
  kaiten search таймаут вебхук
  kaiten search оплата --status done
`,
  pull: `kaiten pull — получить свежие задачи проекта на эту машину.

Нужен перед работой, если задачи давно не обновлялись. Первый запуск
загружает задачи проекта целиком.

Флаги:
  --project <имя>     проект, если команда запущена не из его репозитория

Пример:
  kaiten pull
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
  /** Репозиторий кода проекта, из которого запущена команда. */
  currentRepo: string | null;
  tasksDir: string;
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
  const tasksName = loaded.project.tasksRepo?.name ?? `${key}-tasks`;
  const tasksDir = resolve(process.env.TASKS_DIR ?? join(homedir(), '.kaiten', tasksName));
  return { loaded, currentRepo, tasksDir };
}

function loadIndex(ctx: Context): TaskIndex {
  if (!existsSync(ctx.tasksDir)) {
    throw new UsageError(`Задач проекта ${ctx.loaded.project.title} на этой машине ещё нет. Получите их: kaiten pull`);
  }
  const tree = readTasksTree(ctx.tasksDir);
  const index = buildIndex(tree.files, tree.logs);
  if (!belongsToProject(index.tasks, ctx.loaded.project.repos.map((r) => r.name))) {
    throw new UsageError(`В ${ctx.tasksDir} задачи другого проекта, не ${ctx.loaded.project.title}. Проверьте TASKS_DIR или --project.`);
  }
  return index;
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

function parse(
  command: string,
  args: string[],
  options: Options,
  maxPositionals = Infinity,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`${flagError(error)}\nСправка: kaiten ${command} --help`);
  }
  if (parsed.positionals.length > maxPositionals) {
    throw new UsageError(`Лишний аргумент: ${parsed.positionals.slice(maxPositionals).join(' ')}\nСправка: kaiten ${command} --help`);
  }
  return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
}

function listOf<T extends string>(raw: string | boolean | undefined, allowed: readonly T[], flag: string): T[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = items.filter((s) => !(allowed as readonly string[]).includes(s));
  if (bad.length > 0) throw new UsageError(`--${flag}: нет значения ${bad.join(', ')}. Можно: ${allowed.join(', ')}`);
  return items as T[];
}

function buildFilter(ctx: Context, index: TaskIndex, values: Record<string, string | boolean | undefined>): TaskFilter {
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

// ── команды ──────────────────────────────────────────────────────────────

function list(args: string[]): void {
  const { values } = parse('list', args, { ...FILTERS, all: { type: 'boolean' }, closed: { type: 'boolean' } }, 0);
  const ctx = resolveContext(values.project as string | undefined);
  const index = loadIndex(ctx);
  const filter = buildFilter(ctx, index, values);
  const scope = filter.repo ?? (values.all ? null : ctx.currentRepo);
  if (scope) filter.repo = scope;

  const tasks = sortTasks(filterTasks(index.tasks, filter));
  if (values.json) {
    console.log(JSON.stringify(tasks.map((t) => taskJson(index.tasks, t)), null, 2));
  } else {
    const where = scope ? `${ctx.loaded.project.title} · ${scope}` : `${ctx.loaded.project.title}, весь проект`;
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
  const ctx = resolveContext(values.project as string | undefined);
  const index = loadIndex(ctx);
  const found = resolveTask(index.tasks, positionals[0]);
  if ('error' in found) {
    const broken = index.problems.find((p) => p.path.endsWith(`/${positionals[0]}.md`));
    throw new UsageError(broken ? `Задача ${broken.path} не читается: ${broken.message}` : found.error, 1);
  }
  const filePath = join(ctx.tasksDir, found.task.path);
  if (values.json) console.log(JSON.stringify({ ...showJson(index.tasks, found.task), file: filePath }, null, 2));
  else process.stdout.write(formatShow(index.tasks, found.task, filePath));
}

function search(args: string[]): void {
  const { values, positionals } = parse('search', args, FILTERS);
  if (positionals.length === 0) throw new UsageError('Укажите слова для поиска: kaiten search таймаут вебхук');
  const ctx = resolveContext(values.project as string | undefined);
  const index = loadIndex(ctx);
  const filter = { ...buildFilter(ctx, index, values), closed: true };
  const hits = searchTasks(filterTasks(index.tasks, filter), positionals.join(' '));
  if (values.json) {
    console.log(JSON.stringify(hits.map((h) => ({ ...taskJson(index.tasks, h.task), snippet: h.snippet })), null, 2));
  } else {
    console.log(`${ctx.loaded.project.title} · найдено: ${hits.length}\n`);
    if (hits.length > 0) console.log(formatSearch(index.tasks, hits, true).join('\n'));
  }
  reportProblems(index);
}

function pull(args: string[]): void {
  const { values } = parse('pull', args, {}, 0);
  const ctx = resolveContext(values.project as string | undefined);
  const title = ctx.loaded.project.title;
  const run = (cwd: string, gitArgs: string[]): void => {
    try {
      execFileSync('git', gitArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (error) {
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim().split('\n')[0] : '';
      throw new UsageError(`Не удалось получить задачи проекта ${title}${stderr ? `: ${stderr}` : ''}`, 1);
    }
  };

  if (!existsSync(ctx.tasksDir)) {
    const url = ctx.loaded.project.tasksRepo?.url;
    if (!url) throw new UsageError(`Задачи проекта ${title} ещё негде взять: хранилище задач не подключено. Это вопрос к владельцу проекта.`);
    run(process.cwd(), ['clone', '--quiet', url, ctx.tasksDir]);
  } else {
    if (git(ctx.tasksDir, ['rev-parse', '--is-inside-work-tree']) !== 'true' || !git(ctx.tasksDir, ['remote'])) {
      throw new UsageError(`Задачи проекта ${title} в ${ctx.tasksDir} не связаны с общим хранилищем — обновить их нельзя.`);
    }
    const dirty = git(ctx.tasksDir, ['status', '--porcelain']);
    if (dirty) {
      // Строки вида ` M путь`, `?? путь`; у первой ведущий пробел срезан trim().
      const files = dirty.split('\n').map((l) => l.replace(/^\s*\S{1,2}\s+/, '')).slice(0, 10);
      throw new UsageError(
        `Задачи изменены вручную, а не командами kaiten: ${files.join(', ')}.\nВерните эти файлы как были и повторите kaiten pull.`,
      );
    }
    run(ctx.tasksDir, ['pull', '--rebase', '--quiet']);
  }

  const index = loadIndex(ctx);
  const open = index.tasks.filter((t) => !t.closed).length;
  console.log(`Задачи проекта ${title} обновлены: открытых ${open}, всего ${index.tasks.length}.`);
  reportProblems(index);
}

const COMMANDS: Record<string, (args: string[]) => void> = { list, show, search, pull };

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
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  process.exit(error.code);
}
