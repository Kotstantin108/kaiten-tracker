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
import type { TaskStatus } from './core/schema.js';
import { buildIndex, belongsToProject, resolveTask, type TaskIndex, type TaskRecord } from './core/tasks-index.js';
import { localCopyDir, loadSettings, PROJECT_FILE, readProjectFile, type KaitenSettings } from './kaiten-context.js';
import { formatProblems } from './kaiten-format.js';
import { repoWebBase } from './core/kaiten-sync-plan.js';
import { KaitenClient } from './kaiten-client.js';
import { apiErrorText, runKaitenSync, type SyncRun } from './kaiten-sync.js';
import { KAITEN_LOCK, KAITEN_QUEUE, recordOp, sendInBackground, setKaitenErrors, syncStore, takeNotices, tryLock, withLockAsync } from './store-write.js';
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
  /** Папка, из которой запущена команда: в ней ищется `.kaiten`, в ней же работает фоновая отправка. */
  workDir: string;
}

/**
 * Откуда запустили команду. `npm run kaiten` переводит процесс в папку
 * инструмента, а исходную кладёт в `INIT_CWD` — без неё `.kaiten` не найти.
 */
function invocationDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

export function resolveContext(): Context {
  const workDir = invocationDir();
  const found = readProjectFile(workDir);
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
  return { loaded, title: loaded.project.title, currentRepo: found.file.repo, store, workDir };
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

/** Реестр людей: почта (в нижнем регистре) → человек. Нет файла — пусто. */
export function loadPeople(): Record<string, string> {
  if (!existsSync(PEOPLE_PATH)) return {};
  const { emails } = PeopleSchema.parse(JSON.parse(readFileSync(PEOPLE_PATH, 'utf8')));
  return Object.fromEntries(Object.entries(emails).map(([email, person]) => [email.toLowerCase(), person]));
}

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
  const key = email ? loadPeople()[email] : undefined;
  if (key) return key;
  throw new UsageError('Не знаю, кто вы: укажите себя (person) в настройках kaiten.');
}

/** Сегодня по местному времени, `YYYY-MM-DD`. */
export function today(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ── отправка и сообщения о ней ───────────────────────────────────────────

/**
 * Шаг Kaiten после отправки в git (решение 16): только при включённом
 * `sync.kaiten`. Тот же план, что показывает `npm run kaiten-sync`, без
 * первой заливки. Ключи карточек и «доставлено» возвращаются в задачи
 * операциями `synced` через журнал и уходят общим тем же проходом. Ошибки —
 * в журнал: о них скажет следующая команда. `client` подменяется в тестах.
 */
export async function syncWithKaiten(ctx: Context, client?: KaitenClient, onLocked?: () => void): Promise<SyncRun | null> {
  const current = settings();
  if (!current.sync.kaiten) return null;
  const mapping = ctx.loaded.project.mapping;
  const login = current.kaiten;
  if (!mapping || (!login && !client)) {
    const reason = mapping ? 'не настроен вход в Kaiten (kaiten.domain и kaiten.token в настройках)' : 'доска проекта не настроена';
    setKaitenErrors(ctx.store, [{ what: 'синхронизация', reason }]);
    return null;
  }
  const kaiten = client ?? new KaitenClient({ domain: login?.domain ?? '', token: login?.token ?? '', minIntervalMs: 150 });
  // Один шаг Kaiten на хранилище: второй параллельный создал бы вторую карточку той же задаче.
  return withLockAsync(ctx.store, KAITEN_LOCK, async () => {
    onLocked?.();
    let run: SyncRun;
    try {
      run = await runKaitenSync(
        kaiten,
        {
          tasks: loadTasks(ctx).index.tasks,
          mapping,
          ignore: ctx.loaded.project.ignoreCards,
          repoWebBase: repoWebBase(ctx.loaded.project.tasksRepo?.url),
          defaultTeam: ctx.loaded.config.defaultTeam,
          boardId: mapping.boardId,
          people: loadPeople(),
          date: today(),
        },
        'apply',
      );
    } catch (error) {
      setKaitenErrors(ctx.store, [{ what: 'синхронизация', reason: apiErrorText(error) }]);
      return null;
    }
    for (const { op, what } of run.ops) {
      const recorded = recordOp(ctx.store, op, what, today());
      if ('error' in recorded) run.errors.push({ what, message: recorded.error });
      // Пропущенное зеркалом (файл стал бы битым) — тоже человеку, иначе молча каждый проход.
      else for (const w of recorded.warnings) run.errors.push({ what: 'поля из Kaiten', message: w });
    }
    if (run.ops.length > 0) {
      try {
        syncStore(ctx.store);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
      }
    }
    setKaitenErrors(
      ctx.store,
      run.errors.map((e) => ({ what: e.what, reason: e.message })),
    );
    return run;
  });
}

/**
 * Команды статуса (`start/review/done/block/cancel`) при включённой
 * синхронизации: сначала карточка — статусом владеет Kaiten (Q30), файл — его
 * зеркало. Отказ Kaiten (ограничение доски: 400 с `error_text`, который
 * написал владелец) останавливает команду, и файл не меняется. Без карточки
 * или для карточки из `ignoreCards` — ничего не делаем: статус меняет только
 * файл.
 *
 * `'off'` — карточка есть, но синхронизация выключена: статус меняется только в
 * файле, а при включении синхронизации сверка вернёт в файл колонку карточки.
 * Команда говорит об этом человеку (`cardNotMovedNote`), а не молчит.
 */
export async function moveCardFirst(ctx: Context, task: TaskRecord, status: TaskStatus, client?: KaitenClient): Promise<'moved' | 'off' | 'none'> {
  const current = settings();
  const cardId = task.fm.tracker !== undefined && /^\d+$/.test(task.fm.tracker) ? Number(task.fm.tracker) : null;
  const column = ctx.loaded.project.mapping?.columns[status];
  if (cardId === null || column === undefined || ctx.loaded.project.ignoreCards.includes(cardId)) return 'none';
  if (!current.sync.kaiten) return 'off';
  const login = current.kaiten;
  if (!login && !client) throw new UsageError('Не настроен вход в Kaiten: kaiten.domain и kaiten.token в настройках kaiten.', 2);
  const kaiten = client ?? new KaitenClient({ domain: login?.domain ?? '', token: login?.token ?? '' });
  try {
    await kaiten.updateCard(cardId, { column_id: column });
  } catch (error) {
    throw new UsageError(`Не записано: Kaiten не разрешил — ${apiErrorText(error)}`, 1);
  }
  return 'moved';
}

/** Карточка не сдвинута, потому что обновление Kaiten выключено, — что сделать человеку. */
export function cardNotMovedNote(result: 'moved' | 'off' | 'none'): void {
  if (result !== 'off') return;
  console.log('  Карточка в Kaiten не сдвинута: обновление Kaiten выключено в настройках kaiten. Переставьте её в Kaiten руками — иначе задача вернётся в прежний статус.');
}

/** Отправить общим и обновить Kaiten. Ошибки записаны в журнал — о них скажет следующая команда. */
export async function sendAll(ctx: Context, client?: KaitenClient): Promise<void> {
  try {
    sendInBackground(ctx.store);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return;
  }
  // Шаг Kaiten — тоже с очередью не длиннее одного: он строит план по всему хранилищу, и тот,
  // кто уже ждёт, увидит и эту запись.
  const leaveQueue = tryLock(ctx.store, KAITEN_QUEUE);
  if (!leaveQueue) return;
  let run: SyncRun | null;
  try {
    run = await syncWithKaiten(ctx, client, leaveQueue);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return;
  } finally {
    leaveQueue();
  }
  // Поля из Kaiten могли переложить задачи (закрытая — в архив): копия для чтения — следом.
  if (run && run.ops.length > 0) refreshLocalCopy(ctx);
}

/**
 * Отправить записанное общим. По умолчанию — отдельным фоновым процессом
 * (`kaiten __send`), команда не ждёт сеть. `KAITEN_SEND=inline` — сразу, в
 * этом процессе; `off` — не отправлять (тесты и пробные прогоны).
 */
export async function startSend(ctx: Context): Promise<void> {
  const mode = process.env.KAITEN_SEND;
  if (mode === 'off') return;
  if (mode === 'inline') {
    await sendAll(ctx);
    return;
  }
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '__send'], {
    cwd: ctx.workDir,
    // «detached» обязателен и на Windows: без него отправка не переживает команду (проверено 30.09 —
    // push не уходит). Цена: у процесса нет консоли, поэтому каждый вызов git — с `windowsHide`.
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
      return 'Нет связи с хранилищем задач: запрос повторён трижды, ответа нет. Это сеть, а не доступ. Проверьте интернет и повторите.';
    case 'not-found':
      return 'Хранилище задач проекта не найдено. Это вопрос к владельцу проекта.';
    case 'no-identity':
      return 'Для истории изменений не задано ваше имя и почта: git config --global user.name "…" и user.email "…".';
    case 'busy':
      return 'Задачи сейчас меняет другая команда kaiten — она не закончила за две минуты. Повторите команду.';
    case 'refused':
      return 'Хранилище задач не принимает изменения по своим правилам. Это вопрос к владельцу проекта.';
    case 'rejected':
      return 'Изменения не удалось отправить: задачи слишком часто меняются одновременно. Повторите kaiten pull.';
    default:
      return 'Задачи проекта на этой машине недоступны. Повторите kaiten pull; если не поможет — сообщите тому, кто настраивал kaiten.';
  }
}

/** Что не применилось и что не отправлено — в начале любой команды. */
export function printNotices(ctx: Context): void {
  if (!isStore(ctx.store)) return;
  let notices;
  try {
    notices = takeNotices(ctx.store);
  } catch (error) {
    // Сообщения прошлых команд — не повод отказать этой: сосед держит замок, скажем в следующий раз.
    if (error instanceof StoreError && error.kind === 'busy') return;
    throw error;
  }
  for (const f of notices.failed) console.error(`Не применено: ${f.what} — ${f.reason}.`);
  // Задачи при этом записаны и отправлены — не дошло только до Kaiten.
  for (const k of notices.kaiten) console.error(`Kaiten не обновлён: ${k.what} — ${k.reason}.`);
  if (notices.pending > 0 && notices.problem) {
    console.error(`Изменения ещё не отправлены (${notices.pending}). ${storeMessage(notices.problem)}`);
  }
  if (notices.failed.length > 0 || notices.kaiten.length > 0 || (notices.pending > 0 && notices.problem)) console.error('');
}
