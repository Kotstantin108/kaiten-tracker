/**
 * Общее для команд CLI `kaiten`: контекст (проект из `.kaiten`, хранилище),
 * загрузка задач, разбор флагов, сообщения. Правило вывода — в шапке
 * `kaiten.ts`: никаких путей хранилища, сырых ошибок git и стека.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { z } from 'zod';

import { loadConfig, loadProject, type LoadedProject } from './config.js';
import { buildIndex, belongsToProject, resolveTask, type TaskIndex, type TaskRecord } from './core/tasks-index.js';
import { localCopyDir, loadSettings, PROJECT_FILE, readProjectFile, type KaitenSettings } from './kaiten-context.js';
import { formatProblems } from './kaiten-format.js';
import { sendInBackground, takeNotices } from './store-write.js';
import { defaultStorePath, gitText, isStore, listEntries, readStoreTree, StoreError, syncCopy, type StoreEntry } from './task-store.js';

export class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

export const CONFIG_PATH = process.env.KAITEN_CONFIG ?? fileURLToPath(new URL('../tracker.config.json', import.meta.url));
export const SETTINGS_PATH = process.env.KAITEN_SETTINGS ?? fileURLToPath(new URL('../kaiten.settings.json', import.meta.url));
const PEOPLE_PATH = fileURLToPath(new URL('../convert/people.json', import.meta.url));

export const TASK_REF_HELP = 'Задача — ключ карточки (PRJ-123 или 10000002), id или slug.';

// ── контекст ─────────────────────────────────────────────────────────────

export interface Context {
  loaded: LoadedProject;
  title: string;
  /** Репозиторий кода проекта, из которого запущена команда (из `.kaiten`). */
  currentRepo: string;
  store: string;
}

export function resolveContext(): Context {
  const found = readProjectFile(process.cwd());
  if ('missing' in found) {
    throw new UsageError(`Этот репозиторий не подключён к kaiten: в нём нет файла ${PROJECT_FILE}. Подключает репозиторий владелец проекта.`);
  }
  if ('error' in found) throw new UsageError(`Файл ${PROJECT_FILE} этого репозитория не читается: ${found.error}. Исправляет владелец проекта.`);

  const { projects } = loadConfig(CONFIG_PATH);
  const key = found.file.project;
  if (!projects[key]) {
    throw new UsageError(`Файл ${PROJECT_FILE}: проекта «${key}» в kaiten нет (есть: ${Object.keys(projects).join(', ')}). Исправляет владелец проекта.`);
  }
  const loaded = loadProject(CONFIG_PATH, key);
  const repos = loaded.project.repos.map((r) => r.name);
  if (!repos.includes(found.file.repo)) {
    throw new UsageError(`Файл ${PROJECT_FILE}: в проекте ${loaded.project.title} нет репозитория «${found.file.repo}» (есть: ${repos.join(', ')}). Исправляет владелец проекта.`);
  }
  const store = storePathOf(loaded);
  return { loaded, title: loaded.project.title, currentRepo: found.file.repo, store };
}

function storePathOf(loaded: LoadedProject): string {
  return defaultStorePath(loaded.project.tasksRepo?.name ?? `${loaded.key}-tasks`);
}

export interface Loaded {
  index: TaskIndex;
  entries: StoreEntry[];
}

export function loadTasks(ctx: Context): Loaded {
  if (!existsSync(ctx.store)) throw new UsageError(`Задач проекта ${ctx.title} на этой машине ещё нет. Получите их: kaiten pull`);
  if (!isStore(ctx.store)) throw new StoreError('not-store');
  const entries = listEntries(ctx.store);
  const tree = readStoreTree(ctx.store, entries);
  const index = buildIndex(tree.files, tree.logs);
  if (!belongsToProject(index.tasks, ctx.loaded.project.repos.map((r) => r.name))) {
    throw new UsageError(`Задачи на этой машине — другого проекта, не ${ctx.title}. Сообщите тому, кто настраивал kaiten.`);
  }
  return { index, entries };
}

export function findTask(index: TaskIndex, ref: string): TaskRecord {
  const found = resolveTask(index.tasks, ref);
  if ('error' in found) {
    const broken = index.problems.find((p) => p.path.endsWith(`/${ref}.md`));
    throw new UsageError(broken ? `Задача ${ref} не читается: ${broken.message}` : found.error, 1);
  }
  return found.task;
}

export function reportProblems(index: TaskIndex): void {
  for (const line of formatProblems(index.problems)) console.error(line);
}

// ── флаги ────────────────────────────────────────────────────────────────

export type Options = NonNullable<ParseArgsConfig['options']>;
export type Values = Record<string, string | boolean | undefined>;

const COMMON: Options = { help: { type: 'boolean', short: 'h' } };

/** Ошибки `parseArgs` приходят по-английски — переводим частые. */
function flagError(error: unknown): string {
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const flag = /'([^']+)'/.exec(message)?.[1] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Нет флага ${flag}.`;
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return `Флагу ${flag.split(' ')[0]} нужно значение.`;
  return message;
}

export function parse(command: string, args: string[], options: Options, maxPositionals = Infinity): { values: Values; positionals: string[] } {
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

export function stringFlag(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

// ── настройки, копия, автор ──────────────────────────────────────────────

export function settings(): KaitenSettings {
  return loadSettings(SETTINGS_PATH);
}

/**
 * Копия для чтения из настроек. Её путь человек задал сам, поэтому в
 * сообщениях он есть; но пишем только когда что-то не так.
 */
export function refreshLocalCopy(ctx: Context, target: string | null = localCopyDir(settings(), ctx.loaded.key)): void {
  if (!target) return;
  const result = syncCopy(ctx.store, listEntries(ctx.store), target, ctx.loaded.key);
  if (result.refused === 'foreign-folder') console.error(`\nКопию для чтения не обновить: папка ${target} не пуста и не похожа на копию задач. Укажите в настройках kaiten другую папку.`);
  if (result.refused === 'inside-repo') console.error(`\nКопию для чтения не обновить: папка ${target} внутри репозитория git. Укажите в настройках kaiten папку вне репозиториев.`);
  if (result.refused === 'other-project') console.error(`\nКопию для чтения не обновить: в папке ${target} копия другого проекта.`);
  if (result.modified.length > 0) {
    console.error(`\nВ копии для чтения изменены вручную и не обновлены (${result.modified.length}):`);
    for (const p of result.modified.slice(0, 10)) console.error(`  ${join(target, p)}`);
    if (result.modified.length > 10) console.error(`  …и ещё ${result.modified.length - 10}`);
    console.error('Правки в копии никуда не уходят. Удалите эти файлы — при следующем обновлении они вернутся как в задачах.');
  }
}

const PeopleSchema = z.object({ emails: z.record(z.string(), z.string()) }).passthrough();

/**
 * Кто создаёт задачу (`created_by`): `person` из настроек, иначе человек по
 * git-почте из `convert/people.json` — тот же реестр, что у конвертера.
 */
export function currentPerson(): string {
  const fromSettings = settings().person;
  if (fromSettings) return fromSettings;
  let email = '';
  try {
    email = gitText(process.cwd(), ['config', 'user.email']).toLowerCase();
  } catch {
    email = '';
  }
  if (email && existsSync(PEOPLE_PATH)) {
    const people = PeopleSchema.parse(JSON.parse(readFileSync(PEOPLE_PATH, 'utf8')));
    const key = people.emails[email];
    if (key) return key;
  }
  throw new UsageError('Не знаю, кто вы: укажите себя (person) в настройках kaiten.');
}

/** Сегодня по местному времени, `YYYY-MM-DD`. */
export function today(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ── отправка и сообщения о ней ───────────────────────────────────────────

/**
 * Отправить записанное общим. По умолчанию — отдельным фоновым процессом
 * (`kaiten __send`), команда не ждёт сеть. `KAITEN_SEND=inline` — сразу, в
 * этом процессе; `off` — не отправлять (тесты и пробные прогоны).
 */
export function startSend(ctx: Context): void {
  const mode = process.env.KAITEN_SEND;
  if (mode === 'off') return;
  if (mode === 'inline') {
    try {
      sendInBackground(ctx.store);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      // Вид ошибки записан в журнал — о нём скажет следующая команда.
    }
    return;
  }
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__send'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
}

export function storeMessage(kind: StoreError['kind']): string {
  switch (kind) {
    case 'no-access':
      return 'Нет доступа к задачам проекта. Попросите владельца проекта добавить вас в команду проекта на GitHub.';
    case 'offline':
      return 'Не удалось связаться с хранилищем задач. Проверьте интернет и повторите.';
    case 'not-found':
      return 'Хранилище задач проекта не найдено. Это вопрос к владельцу проекта.';
    case 'no-identity':
      return 'Для истории изменений не задано ваше имя и почта: git config --global user.name "…" и user.email "…".';
    case 'busy':
      return 'Задачи сейчас меняет другая команда kaiten. Повторите через несколько секунд.';
    case 'rejected':
      return 'Изменения не удалось отправить: задачи слишком часто меняются одновременно. Повторите kaiten pull.';
    default:
      return 'Задачи проекта на этой машине недоступны. Повторите kaiten pull; если не поможет — сообщите тому, кто настраивал kaiten.';
  }
}

/** Что не применилось и что не отправлено — в начале любой команды. */
export function printNotices(ctx: Context): void {
  if (!isStore(ctx.store)) return;
  const notices = takeNotices(ctx.store);
  for (const f of notices.failed) console.error(`Не применено: ${f.what} — ${f.reason}.`);
  if (notices.pending > 0 && notices.problem) {
    console.error(`Изменения ещё не отправлены (${notices.pending}). ${storeMessage(notices.problem)}`);
  }
  if (notices.failed.length > 0 || (notices.pending > 0 && notices.problem)) console.error('');
}
