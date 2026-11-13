/**
 * Общее для команд CLI `kaiten`: контекст (проект из `.kaiten`, хранилище),
 * загрузка задач, разбор флагов, сообщения. Правило вывода — в шапке
 * `kaiten.ts`: никаких путей хранилища, сырых ошибок git и стека.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { z } from 'zod';

import { juniorFields, visualFields, loadTasksRepoConfig, projectFromTasksRepo, storeNameOf, TASKS_REPO_CONFIG, type LoadedProject, type People } from './config.js';
import { noAccessMessage, noLoginMessage, type Hosting, type RepoWhere } from './core/hosting.js';
import { CLOSED_STATUSES, type Priority, type TaskStatus } from './core/schema.js';
import { VISUAL_DIR } from './core/visual.js';
import { JOURNAL_FILE, taskDate, type QueuedMoves } from './core/task-ops.js';
import { buildIndex, belongsToProject, resolveTask, type TaskIndex, type TaskRecord } from './core/tasks-index.js';
import { localCopyDir, loadSettings, PROJECT_FILE, readProjectFile, type KaitenSettings } from './kaiten-context.js';
import { formatProblems } from './kaiten-format.js';
import { repoWebBase, type AttachmentRef } from './core/kaiten-sync-plan.js';
import { isOutage, KaitenClient, outageText, type KaitenApiError } from './kaiten-client.js';
import { apiErrorText, runKaitenSync, type SyncRun } from './kaiten-sync.js';
import { KAITEN_LOCK, KAITEN_QUEUE, recordOp, sendInBackground, setKaitenErrors, syncStore, takeNotices, tryLock, withLockAsync } from './store-write.js';
import { isOutdated, OUTDATED_NOTE, publishSyncVersion } from './self-update.js';
import { defaultStorePath, gitText, isStore, listEntries, readBlobs, readStoreTree, StoreError, syncCopy, type StoreEntry } from './task-store.js';

export class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

/** Конфиг проекта вместо `kaiten.json` из хранилища — для тестов и пробных прогонов. */
export const CONFIG_OVERRIDE = process.env.KAITEN_CONFIG;
export const SETTINGS_PATH = process.env.KAITEN_SETTINGS ?? fileURLToPath(new URL('../kaiten.settings.json', import.meta.url));

export const TASK_REF_HELP = 'Задача — ключ карточки (PRJ-123 или номер карточки), id или slug.';

// ── контекст ─────────────────────────────────────────────────────────────

export interface Context {
  /** Проект из `kaiten.json` хранилища; до первого `kaiten pull` — отказ «получите задачи». */
  readonly loaded: LoadedProject & { people: People };
  readonly title: string;
  /** Адрес репозитория задач из `.kaiten`. */
  tasksUrl: string;
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
export function invocationDir(): string {
  // INIT_CWD ставит любой `npm run`/`npx`. Верим ему только при запуске через `npm run kaiten`
  // самого инструмента: иначе kaiten, вызванный из скрипта другого проекта, искал бы `.kaiten` не там.
  const viaOwnScript = process.env.npm_package_name === 'kaiten-tracker' && process.env.npm_lifecycle_event === 'kaiten';
  return viaOwnScript && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
}

export function resolveContext(): Context {
  const workDir = invocationDir();
  const found = readProjectFile(workDir);
  if ('missing' in found) {
    throw new UsageError(`Этот репозиторий не подключён к kaiten: в нём нет файла ${PROJECT_FILE}. Подключает репозиторий владелец проекта.`);
  }
  if ('error' in found) throw new UsageError(`Файл ${PROJECT_FILE} этого репозитория не читается: ${found.error}. Исправляет владелец проекта.`);

  const tasksUrl = found.file.tasks;
  const store = defaultStorePath(storeNameOf(tasksUrl));
  const currentRepo = found.file.repo;
  let cached: (LoadedProject & { people: People }) | null = null;
  // Проект читается из хранилища при первом обращении: до первого pull его ещё нет, а адрес для pull — уже есть.
  const loaded = (): LoadedProject & { people: People } => {
    if (cached) return cached;
    const project = readProjectConfig(store, tasksUrl);
    const repos = project.project.repos.map((r) => r.name);
    if (!repos.includes(currentRepo)) {
      throw new UsageError(`Файл ${PROJECT_FILE}: в проекте ${project.project.title} нет репозитория «${currentRepo}» (есть: ${repos.join(', ')}). Исправляет владелец проекта.`);
    }
    cached = project;
    return project;
  };
  return {
    get loaded() {
      return loaded();
    },
    get title() {
      return loaded().project.title;
    },
    tasksUrl,
    currentRepo,
    store,
    workDir,
  };
}

/** `kaiten.json` из хранилища (или файл из `KAITEN_CONFIG`). */
function readProjectConfig(store: string, tasksUrl: string): LoadedProject & { people: People } {
  try {
    if (CONFIG_OVERRIDE) return loadTasksRepoConfig(CONFIG_OVERRIDE);
    if (!existsSync(store)) throw new UsageError('Задач проекта на этой машине ещё нет. Получите их: kaiten pull');
    if (!isStore(store)) throw new StoreError('not-store');
    const entry = listEntries(store).find((e) => e.path === TASKS_REPO_CONFIG);
    if (!entry) throw new UsageError('В репозитории задач нет описания проекта. Сообщите владельцу проекта.');
    const text = readBlobs(store, [entry.sha]).get(entry.sha)?.toString('utf8') ?? '';
    return projectFromTasksRepo(text, tasksUrl);
  } catch (error) {
    if (error instanceof UsageError || error instanceof StoreError) throw error;
    throw new UsageError(`Описание проекта в репозитории задач не читается: ${(error as Error).message}. Сообщите владельцу проекта.`);
  }
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

/** Реестр людей проекта: почта (в нижнем регистре) → человек. */
export function peopleByEmail(people: People): Record<string, string> {
  return Object.fromEntries(Object.entries(people.emails).map(([email, person]) => [email.toLowerCase(), person]));
}

/**
 * Кто создаёт задачу (`created_by`): `person` из настроек, иначе человек по
 * git-почте из реестра людей проекта (`people` в `kaiten.json`).
 */
export function currentPerson(people: People): string {
  const fromSettings = settings().person;
  if (fromSettings) return fromSettings;
  let email = '';
  try {
    email = gitText(process.cwd(), ['config', 'user.email']).toLowerCase();
  } catch {
    email = '';
  }
  const key = email ? peopleByEmail(people)[email] : undefined;
  if (key) return key;
  throw new UsageError('Не знаю, кто вы: укажите себя (person) в настройках kaiten.');
}

/** Сегодня по Москве, `YYYY-MM-DD`, — на любой машине. */
export function today(now = new Date()): string {
  return taskDate(now);
}

// ── отправка и сообщения о ней ───────────────────────────────────────────

/** Вложения задач из хранилища (`attachments/<slug>/<имя>`) — для файлов карточек. */
export function attachmentRefs(entries: readonly StoreEntry[]): Map<string, AttachmentRef[]> {
  const out = new Map<string, AttachmentRef[]>();
  for (const e of entries) {
    const m = /^attachments\/([^/]+)\/(.+)$/.exec(e.path);
    if (!m) continue;
    out.set(m[1], [...(out.get(m[1]) ?? []), { name: m[2], sha: e.sha, size: e.size }]);
  }
  return out;
}

export type ForeignFiles = { files: Array<{ name: string; size: number }> } | { unreachable: true } | null;

/**
 * Файлы карточки Kaiten, которых нет в задаче: их приложили люди прямо в
 * Kaiten (выгрузка замечаний, счёт). Вложения задачи и журнал приходят из git —
 * их `kaiten show` показывает и так. Нет карточки или входа в Kaiten — `null`
 * (строки нет); Kaiten не ответил — `unreachable`, без подробностей.
 */
export async function foreignCardFiles(ctx: Context, task: TaskRecord, attachments: readonly string[], client?: KaitenClient): Promise<ForeignFiles> {
  const cardId = task.fm.tracker !== undefined && /^\d+$/.test(task.fm.tracker) ? Number(task.fm.tracker) : null;
  if (cardId === null || ctx.loaded.project.ignoreCards.includes(cardId)) return null;
  const login = settings().kaiten;
  if (!login && !client) return null;
  if (!client && kaitenDownNote(ctx.store)) return { unreachable: true };
  // Это самая частая команда агентов: без связи — не дольше 3 секунд и без повтора.
  const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(3000) });
  const kaiten = client ?? new KaitenClient({ domain: login?.domain ?? '', token: login?.token ?? '', maxRetries: 0, fetchImpl: timed });
  try {
    const card = await kaiten.getCard(cardId);
    const own = new Set([...attachments, JOURNAL_FILE].map((name) => name.toLowerCase()));
    // Картинки «Было / Стало», убранные из задачи, — не людей: их уберёт сверка.
    const files = (card.files ?? []).filter((f) => !own.has(f.name.toLowerCase()) && !f.name.toLowerCase().startsWith(`${VISUAL_DIR}/`)).map((f) => ({ name: f.name, size: Number(f.size) }));
    return { files };
  } catch {
    return { unreachable: true };
  }
}

/** Содержимое вложения по git-объекту — по требованию: читаются только отправляемые. */
export function blobReader(store: string): (sha: string) => Uint8Array {
  return (sha) => {
    const blob = readBlobs(store, [sha]).get(sha);
    if (!blob) throw new Error('вложение задачи не прочитать на этой машине — kaiten pull');
    return blob;
  };
}

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
    // Устаревший kaiten переписал бы карточки по-старому; обновиться он пробовал в начале команды.
    if (isOutdated(ctx.store)) {
      setKaitenErrors(ctx.store, [{ what: 'синхронизация', reason: OUTDATED_NOTE }]);
      return null;
    }
    publishSyncVersion(ctx.store, today());
    const down = await kaitenDown(ctx.store, client, login);
    if (down) {
      setKaitenErrors(ctx.store, [{ what: 'синхронизация', reason: `${down}; задачи и статусы записываются, карточки догонят, когда он вернётся` }]);
      return null;
    }
    let run: SyncRun;
    try {
      const loaded = loadTasks(ctx);
      run = await runKaitenSync(
        kaiten,
        {
          tasks: loaded.index.tasks,
          attachments: attachmentRefs(loaded.entries),
          readFile: blobReader(ctx.store),
          mapping,
          archiveInKaiten: ctx.loaded.project.kaiten.archiveInKaiten,
          junior: juniorFields(ctx.loaded.project),
          visual: visualFields(ctx.loaded.project),
          ignore: ctx.loaded.project.ignoreCards,
          repoWebBase: repoWebBase(ctx.loaded.project.tasksRepo?.url, ctx.loaded.project.tasksRepo?.hosting),
          defaultTeam: ctx.loaded.config.defaultTeam,
          boardId: mapping.boardId,
          people: peopleByEmail(ctx.loaded.people),
          date: today(),
        },
        'apply',
      );
    } catch (error) {
      if (isOutage(error)) noteKaitenDown(ctx.store, outageText(error));
      setKaitenErrors(ctx.store, [{ what: 'синхронизация', reason: isOutage(error) ? `${outageText(error)}; задачи и статусы записываются, карточки догонят, когда он вернётся` : apiErrorText(error) }]);
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
 *
 * `priority` — тем же запросом поставить карточке приоритет (`start --assigned`
 * для задачи без приоритета).
 *
 * `'queued'` — Kaiten недоступен (сбой, а не отказ): шаг ложится в `queue`, команда
 * пишет его в задачу (`pending_moves`), и работа не останавливается; ограничения доски
 * проверит синхронизация, когда он вернётся. Задача уже ждёт Kaiten — шаг встаёт в
 * ту же очередь, иначе карточка перескочила бы через шаги.
 */
export async function moveCardFirst(
  ctx: Context,
  task: TaskRecord,
  status: TaskStatus,
  client?: KaitenClient,
  priority?: Priority,
  queue: MoveStep[] = [],
): Promise<CardMove> {
  const current = settings();
  const cardId = task.fm.tracker !== undefined && /^\d+$/.test(task.fm.tracker) ? Number(task.fm.tracker) : null;
  const column = ctx.loaded.project.mapping?.columns[status];
  const step: MoveStep = { status, ...(priority !== undefined ? { priority } : {}) };
  // Карточки ещё нет, но она появится сама: задачу только что завели, и фоновая отправка создаёт
  // карточку по тому статусу, который задача имела в момент её прохода. Шаг — в очередь задачи:
  // иначе первая же сверка вернула бы задаче колонку свежей карточки («Входящие») — живьём 12.11.
  if (cardId === null && column !== undefined && awaitsCard(task) && current.sync.kaiten) {
    queue.push(step);
    return 'awaits-card';
  }
  if (cardId === null || column === undefined || ctx.loaded.project.ignoreCards.includes(cardId)) return 'none';
  if (!current.sync.kaiten) return 'off';
  const login = current.kaiten;
  if (!login && !client) throw new UsageError('Не настроен вход в Kaiten: kaiten.domain и kaiten.token в настройках kaiten.', 2);
  const enqueue = (): 'queued' => {
    queue.push(step);
    return 'queued';
  };
  if (task.fm.pending_moves || queue.length > 0 || (!client && kaitenDownNote(ctx.store))) return enqueue();
  const kaiten = client ?? quickClient(login);
  try {
    const priorityProperty = ctx.loaded.project.mapping?.priorityProperty;
    const value = priority !== undefined ? priorityProperty?.values[priority] : undefined;
    const properties = priorityProperty && value !== undefined ? { [`id_${priorityProperty.id}`]: [value] } : undefined;
    // Задачу открыли снова, а карточка в архиве Kaiten: колонка у архивной меняется, но
    // карточка остаётся в архиве (живьём 19.10) — достаём тем же запросом.
    const reopen = !CLOSED_STATUSES.includes(status) ? { condition: 1 as const } : {};
    await kaiten.updateCard(cardId, { column_id: column, ...reopen, ...(properties ? { properties } : {}) });
  } catch (error) {
    // 5xx может быть и ответом на сам запрос: сбой — только если Kaiten не отвечает и на простой вопрос.
    if (isOutage(error) && (await confirmedDown(ctx.store, kaiten, error))) return enqueue();
    throw new UsageError(`Не записано: Kaiten не разрешил — ${apiErrorText(error)}`, 1);
  }
  markKaitenUp(ctx.store);
  return 'moved';
}

/**
 * Задача ждёт свою карточку: заведена командой (такие карточки создаёт сама
 * синхронизация), а ключа ещё нет. У перенесённых задач без `created_via`
 * карточку заводит только первая заливка владельца — им ждать нечего.
 */
function awaitsCard(task: TaskRecord): boolean {
  return task.fm.tracker === undefined && task.fm.created_via !== undefined;
}

/**
 * Поле операции для команд статуса: шаги, которые карточка получит позже.
 * `card` — чем кончилась команда: `awaits-card` — карточки ещё нет, и говорить
 * в журнале о недоступном Kaiten не нужно.
 */
export function queuedOf(queue: readonly MoveStep[], card?: CardMove): { queued?: QueuedMoves } {
  if (queue.length === 0) return {};
  return { queued: { at: new Date().toISOString(), steps: [...queue], ...(card === 'awaits-card' ? { silent: true } : {}) } };
}

// ── Kaiten недоступен ───────────────────────────────────────────────────

export type CardMove = 'moved' | 'off' | 'none' | 'queued' | 'awaits-card';
export type MoveStep = QueuedMoves['steps'][number];

export const KAITEN_DOWN_NOTE = '  Kaiten сейчас недоступен. Статус записан в задачу, карточка обновится сама, когда он вернётся. Продолжайте работу: повторять команду не нужно.';

const DOWN_FILE = 'kaiten-down.json';
/** Сколько помнить о сбое: команды не ждут ответа заново, а вернувшийся Kaiten замечается быстро. */
const DOWN_TTL_MS = 60_000;
const QUICK_TIMEOUT_MS = 8000;

/** Клиент для команд, которые ждёт человек: один короткий повтор, без долгих пауз. */
function quickClient(login: KaitenSettings['kaiten']): KaitenClient {
  const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(QUICK_TIMEOUT_MS) });
  return new KaitenClient({ domain: login?.domain ?? '', token: login?.token ?? '', maxRetries: 1, fetchImpl: timed, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 500))) });
}

/** Недавний сбой — его описание; не было или устарел — `null`. */
export function kaitenDownNote(store: string, now = Date.now()): string | null {
  try {
    const { at, note } = JSON.parse(readFileSync(join(store, DOWN_FILE), 'utf8')) as { at: number; note: string };
    return now - at < DOWN_TTL_MS ? note : null;
  } catch {
    return null;
  }
}

function noteKaitenDown(store: string, note: string): void {
  try {
    writeFileSync(join(store, DOWN_FILE), JSON.stringify({ at: Date.now(), note }));
  } catch {
    // Память о сбое только экономит время: не записалась — спросим Kaiten ещё раз.
  }
}

/** Явная команда спрашивает Kaiten заново, а не верит памяти о сбое. */
export function markKaitenUp(store: string): void {
  rmSync(join(store, DOWN_FILE), { force: true });
}

async function confirmedDown(store: string, kaiten: KaitenClient, cause: KaitenApiError): Promise<boolean> {
  try {
    await kaiten.currentUser();
    return false;
  } catch (error) {
    if (!isOutage(error)) return false;
    noteKaitenDown(store, outageText(cause));
    return true;
  }
}

/** Перед шагом Kaiten: отвечает ли он. Описание сбоя или `null`; прочие ошибки покажет сам шаг. */
async function kaitenDown(store: string, client: KaitenClient | undefined, login: KaitenSettings['kaiten']): Promise<string | null> {
  if (!client) {
    const known = kaitenDownNote(store);
    if (known) return known;
  }
  try {
    await (client ?? quickClient(login)).currentUser();
    markKaitenUp(store);
    return null;
  } catch (error) {
    if (!isOutage(error)) return null;
    const note = outageText(error);
    noteKaitenDown(store, note);
    return note;
  }
}

/** Карточка не сдвинута: что это значит для человека и агента. */
export function cardNotMovedNote(result: CardMove): void {
  if (result === 'queued') console.log(KAITEN_DOWN_NOTE);
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

/**
 * Где лежат задачи — для сообщений об отказе в доступе: адрес из `.kaiten`, а
 * хостинг своего сервера — из проекта, если задачи уже загружены (до первого
 * `kaiten pull` его взять неоткуда — сообщение назовёт только домен).
 */
export function storeWhere(ctx: Context): RepoWhere {
  let hosting: Hosting | undefined;
  try {
    hosting = ctx.loaded.project.tasksRepo?.hosting;
  } catch {
    hosting = undefined;
  }
  return { url: ctx.tasksUrl, hosting };
}

export function storeMessage(kind: StoreError['kind'], where?: RepoWhere): string {
  switch (kind) {
    case 'no-access':
      return noAccessMessage(where);
    case 'no-login':
      return noLoginMessage(where);
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
    console.error(`Изменения ещё не отправлены (${notices.pending}). ${storeMessage(notices.problem, storeWhere(ctx))}`);
  }
  if (notices.failed.length > 0 || notices.kaiten.length > 0 || (notices.pending > 0 && notices.problem)) console.error('');
}
