/**
 * Операции записи над задачами — чистая часть команд `kaiten check/log/new/
 * cancel/block/edit`. Операция — намерение («отметить пункт X в задаче Y»), а
 * не готовый diff: она хранится в журнале и применяется заново к свежему
 * состоянию задач, когда локальные изменения догоняют общие (`store-write.ts`).
 * Поэтому применение детерминировано: дата — из самой операции, а не «сейчас».
 *
 * Каждая операция возвращает изменения файлов или ошибку «что не так с
 * задачей». Перед записью результат проходит схему и линтер (ошибки
 * блокируют) и проверку, что поля не-файла не тронуты (`foreignFieldChanges`).
 *
 * Статусы работы ставит CLI (владелец 29.09: интеграция Kaiten ↔ GitHub
 * не нужна — в прод вливаем сами): `start` → `in-progress`, `review`, `done`,
 * а ещё `cancelled`, `blocked` и `inbox` новой задаче. Переходы — те же, что
 * ограничения доски (28.09): «В работе» — из «Готово к работе»,
 * «Заблокировано», «Ревью»; «Ревью» — из «В работе»; «Сделано» — из «Ревью»;
 * отмена — из «Входящих», «Бэклога», «Готово к работе». По прямому
 * поручению человека «В работе» — и из «Входящих», «Бэклога» (`ASSIGNABLE`). Эпик так не
 * закрывают: его закрывают в Kaiten, когда закрыты его задачи (решение 7).
 */

import { contentHash, foreignFieldChanges, parseTaskDocument, serializeTaskDocument, TaskParseError } from './document.js';
import { findingPath, isFindingPath, parseFinding, serializeFinding } from './found.js';
import { lintTask, SLUG_RE } from './lint.js';
import { CLOSED_STATUSES, FrontmatterSchema, JOURNAL_FILE, type AssessVerdict, type Frontmatter, type Priority, type TaskStatus, type TaskType, type VisualAnswer } from './schema.js';
import { renderSkeleton } from './skeleton.js';
import { parseSyncVersion, renderSyncVersion, SYNC_VERSION_FILE } from './sync-version.js';
import { buildIndex, refOf, type TaskRecord } from './tasks-index.js';
import { isVisualAttachment } from './visual.js';

export type Op =
  | { kind: 'new'; path: string; text: string }
  | { kind: 'check'; id: string; items: string[]; checked: boolean }
  | { kind: 'log'; id: string; text: string }
  | { kind: 'cancel'; id: string; reason: string; queued?: QueuedMoves }
  | { kind: 'block'; id: string; reason: string; queued?: QueuedMoves }
  /** Статус работы: `kaiten start` (в работу), `review`, `done`. Заметка — в журнал; `visual` — ответ «Было / Стало»; `queued` — Kaiten недоступен, карточка догонит. */
  | { kind: 'move'; id: string; status: WorkStatus; note?: string; assigned?: boolean; branch?: string; visual?: VisualAnswer; queued?: QueuedMoves }
  | { kind: 'edit'; id: string; text: string; baseHash: string }
  /**
   * Вложение задачи: файл `attachments/<slug>/<name>`. Содержимое уже лежит в
   * хранилище объектом `blob` (его кладёт команда до записи операции) — журнал
   * хранит намерение, а не мегабайты. Файл с таким именем заменяется.
   */
  | { kind: 'attach'; id: string; name: string; blob: string }
  /**
   * Убрать картинки «Было / Стало» из задачи: лишние экраны сверх предела,
   * повторы, чужие файлы в папке, картинки `было-…`/`стало-…` мимо папки (на
   * них отказывает `review`). Прочие вложения — нет: файлы папки `было-стало/`
   * сверка убирает и из карточки, а файл с другим именем в карточке не
   * отличить от приложенного человеком — он там остаётся.
   */
  | { kind: 'detach'; id: string; names: string[] }
  /**
   * Служебная операция синхронизации: карточки получили содержимое с этим
   * хешем (и, при создании, — свой ключ). Пакетом — один коммит на проход,
   * а не на задачу (первая заливка — сотни карточек). Меняет только поля CLI
   * и не трогает `updated`: иначе учёт синхронизации сам выглядел бы правкой.
   */
  | { kind: 'synced'; items: SyncedItem[] }
  /**
   * Поля, которыми владеет Kaiten (решение 9, Q30), — в файл: статус, тип,
   * приоритет, команда, срок. Пакетом на проход. Закрылась задача — файл
   * переезжает в `archive/<месяц закрытия>/`, открылась снова — обратно в
   * `active/` (Q42: двигает только синхронизатор), вместе с журналом.
   */
  | { kind: 'mirror'; items: MirrorItem[] }
  /**
   * Карточки, заведённые в интерфейсе Kaiten, — новыми файлами (этап 2c,
   * `kaiten-adopt.ts`). Пакетом на проход. id выведен из карточки: задача с
   * таким id уже есть (перенёс другой разработчик) — пропускается.
   */
  | { kind: 'adopt'; items: AdoptItem[] }
  /**
   * Скрипт оценки (`npm run assess -- --apply`) поставил «Оценку» в карточку:
   * в файл — и зеркало (`assessment`), и что поставил скрипт (`assessed`), с
   * датой операции. Как `synced`, не трогает `updated`.
   */
  | { kind: 'assessed'; items: Array<{ id: string; verdict: AssessVerdict }> }
  /**
   * Версия синхронизации (`core/sync-version.ts`) — файлом в корне репозитория
   * задач. Только растёт: поверх более новой операция ничего не меняет.
   */
  | { kind: 'sync-version'; version: number }
  /** Заметка о находке (`kaiten found`, `core/found.ts`): файл `findings/<id>.md`, ещё не исследована. */
  | { kind: 'found-note'; id: string; text: string }
  /**
   * Вердикт исследования — в заметку. Подтверждена — тем же шагом заводится задача
   * (`task`: готовый файл в статусе «Находки»); повтор — `task.slug` называет
   * задачу, где дефект уже записан. Заметка уже с вердиктом — операция ничего не меняет.
   */
  | { kind: 'found-verdict'; id: string; state: 'confirmed' | 'rejected' | 'duplicate'; reason: string; task?: { slug: string; text?: string } };

/** Что поменять в файле по карточке; `null` — в карточке поле пустое. */
export interface MirrorItem {
  id: string;
  status?: TaskStatus;
  type?: TaskType;
  priority?: Priority | null;
  team?: string | null;
  due?: string | null;
  assessment?: AssessVerdict | null;
  /** Месяц закрытия (YYYY-MM) — по времени переноса карточки в колонку. */
  closedMonth?: string;
  /**
   * Что снять из `pending_moves`: сколько шагов дошло до карточки или `all` — очередь
   * отменена. Числом, потому что за время прохода команда могла дописать новый шаг.
   */
  settled?: number | 'all';
  /** Запись в журнал задачи: почему статус вернулся. */
  note?: string;
}

/** Статус сменён без Kaiten (тот недоступен): что записать в `pending_moves`. */
export interface QueuedMoves {
  /** Момент смены статуса, ISO: карточку, сдвинутую позже, двигал уже человек. */
  at: string;
  steps: Array<{ status: TaskStatus; priority?: Priority }>;
}

/** Поле `pending_moves` после операции: новые шаги — в хвост уже ожидающих. */
function withQueued(task: TaskRecord, queued: QueuedMoves | undefined): Pick<Frontmatter, 'pending_moves'> | Record<string, never> {
  if (!queued) return {};
  const current = task.fm.pending_moves;
  return { pending_moves: { since: current?.since ?? queued.at, from: current?.from ?? task.fm.status, steps: [...(current?.steps ?? []), ...queued.steps] } };
}

const QUEUED_NOTE = '; карточка в Kaiten обновится, когда он вернётся';

/** Готовый файл задачи из карточки; путь выбирает применение (занятое имя — следующее свободное). */
export interface AdoptItem {
  slug: string;
  text: string;
  /** Закрытая карточка — в `archive/<месяц>/`. */
  closedMonth?: string;
}

export interface SyncedItem {
  id: string;
  contentHash: string;
  /** Файлы, которые карточка получила (`files_hash`); нет — поле не меняется. */
  filesHash?: string;
  tracker?: string;
  /** Команда, с которой создана карточка (по умолчанию проекта), — чтобы следующая сверка не переносила её отдельным коммитом. */
  team?: string;
}

export interface OpContext {
  /** Дата операции `YYYY-MM-DD` — из журнала, не «сегодня». */
  date: string;
  /** Время операции для журнала задачи — `logStamp` от момента записи, не «сейчас». */
  stamp: string;
  /** Кто записал — человек из реестра проекта; у операций до 19.10.2026 его нет. */
  by?: string;
}

/** Файлы задач в памяти: путь → текст (задачи и журналы под active/ и archive/, файл версии синхронизации). */
export type TaskTexts = ReadonlyMap<string, string>;

export interface FileChange {
  path: string;
  /** `null` — файл удаляется (перенос в архив). */
  text: string | null;
  /** Содержимое — готовый объект хранилища (вложение); `text` при этом `null`. */
  blob?: string;
}

export type OpResult = { changes: FileChange[]; summary: string; warnings: string[] } | { error: string };

export const CANCELLABLE: readonly TaskStatus[] = ['found', 'inbox', 'backlog', 'ready'];

export type WorkStatus = 'in-progress' | 'review' | 'done';
/** Откуда можно перейти в статус работы — как ограничения доски. */
export const MOVES: Record<WorkStatus, readonly TaskStatus[]> = {
  'in-progress': ['ready', 'blocked', 'review'],
  review: ['in-progress'],
  done: ['review'],
};
const MOVE_WORDS: Record<WorkStatus, string> = { 'in-progress': 'в работе', review: 'на ревью', done: 'сделана' };

/**
 * Откуда задачу берут в работу по прямому поручению человека («сделай
 * задачу N», «заведи и приступай»): поручение и есть разбор. Задача без
 * приоритета получает высший — её взяли сразу (владелец 05.10). Находку — тоже:
 * поручение человека и есть её подтверждение (владелец 12.11).
 */
export const ASSIGNABLE: readonly TaskStatus[] = ['found', 'inbox', 'backlog'];
export const ASSIGNED_PRIORITY: Priority = 'p0';
const ASSIGNED_FROM: Partial<Record<TaskStatus, string>> = { found: '«Находок»', inbox: '«Входящих»', backlog: '«Бэклога»' };

/** Приоритет, который задача получает при взятии в работу; `undefined` — не меняется. */
export function assignedPriority(task: TaskRecord, assigned: boolean): Priority | undefined {
  return assigned && ASSIGNABLE.includes(task.fm.status) && task.fm.priority === undefined ? ASSIGNED_PRIORITY : undefined;
}

/** Что мешает перевести задачу в статус работы; `null` — ничего (или она уже там). */
export function moveProblem(task: TaskRecord, status: WorkStatus, assigned = false): string | null {
  if (task.fm.type === 'epic') return 'это эпик: его закрывают в Kaiten, когда закрыты его задачи';
  if (task.fm.status === status || MOVES[status].includes(task.fm.status)) return null;
  // По прямому поручению человека задачу берут в работу и неразобранной (владелец 30.09, 05.10).
  if (assigned && status === 'in-progress' && ASSIGNABLE.includes(task.fm.status)) return null;
  return `задача в статусе ${task.fm.status}: ${MOVE_WORDS[status]} — только из ${MOVES[status].join(', ')}`;
}
export const BLOCKABLE: readonly TaskStatus[] = ['inbox', 'backlog', 'ready', 'in-progress', 'review'];

// ── чтение состояния ─────────────────────────────────────────────────────

function records(texts: TaskTexts): TaskRecord[] {
  const files: Array<{ path: string; text: string }> = [];
  const logs = new Map<string, string>();
  for (const [path, text] of texts) {
    // Файл версии синхронизации и заметки о находках — не задачи.
    if (!path.endsWith('.md') || isFindingPath(path)) continue;
    if (path.endsWith('.log.md')) logs.set(path.replace(/\.log\.md$/, '.md'), text);
    else files.push({ path, text });
  }
  return buildIndex(files, logs).tasks;
}

function byId(texts: TaskTexts, id: string): TaskRecord | { error: string } {
  const task = records(texts).find((t) => t.fm.id === id);
  return task ?? { error: 'задачи больше нет среди задач проекта' };
}

function logPath(taskPath: string): string {
  return taskPath.replace(/\.md$/, '.log.md');
}

// ── проверка перед записью ───────────────────────────────────────────────

/**
 * Файл, который пишет CLI: `updated` — дата операции, текст канонический.
 * `content_hash` не трогаем: его ставит только синхронизация с Kaiten
 * (операция `synced`), иначе правка считалась бы уже доставленной в карточку.
 */
function finalize(fm: Frontmatter, body: string, date: string): string {
  return serializeTaskDocument({ ...fm, updated: date }, body);
}

/** Ошибки линтера блокируют запись; предупреждения возвращаются как есть. */
function checked(text: string, path: string): { warnings: string[] } | { error: string } {
  const lint = lintTask(text, { path });
  const errors = lint.issues.filter((i) => i.level === 'error').map((i) => i.message);
  if (errors.length > 0) return { error: errors.join('; ') };
  return { warnings: lint.issues.filter((i) => i.level === 'warning' && !i.message.includes('каноническом')).map((i) => i.message) };
}

function write(task: TaskRecord, fm: Frontmatter, body: string, ctx: OpContext, path = task.path): { text: string; warnings: string[] } | { error: string } {
  const text = finalize(fm, body, ctx.date);
  const result = checked(text, path);
  return 'error' in result ? result : { text, warnings: result.warnings };
}

// ── журнал задачи ────────────────────────────────────────────────────────

/** Записи, которые пишут сами команды при смене статуса, — не записи о работе. */
const ASSIGNED_NOTE = String.raw`(?: \(из «[^»]+», по прямому поручению[^)]*\))?`;
const AUTO_ENTRY_RE = new RegExp(String.raw`^(?:(?:в работе|на ревью|сделана)${ASSIGNED_NOTE}(?::|$)|(?:заблокирована|отменена):)`);
// Записи до 19.10.2026 — с одной датой: `## [2026-09-28]`.
const ENTRY_RE = /^## \[\d{4}-\d{2}-\d{2}(?: [^\]]*)?\][ \t]*(.*)$/;

/**
 * Есть ли в журнале запись о работе после последнего взятия в работу: что
 * сделано, почему, чем проверено. Записи `start`/`review`/`block` не в счёт —
 * иначе проверка ничего не значила бы. Задача без записи «в работе» (перенесённая) —
 * в счёт любая запись о работе.
 */
export function hasWorkNote(log: string | null): boolean {
  const heads = (log ?? '').split('\n').flatMap((line) => {
    const m = ENTRY_RE.exec(line);
    return m ? [m[1].trim()] : [];
  });
  const started = heads.map((h) => new RegExp(String.raw`^в работе${ASSIGNED_NOTE}(?::|$)`).test(h)).lastIndexOf(true);
  return heads.slice(started + 1).some((h) => !AUTO_ENTRY_RE.test(h));
}

/**
 * Запись журнала `## [YYYY-MM-DD HH:MM:SS +03:00 · alice] заголовок` + текст.
 * Первая строка текста — заголовок, остальное — тело. Автор — в скобках со
 * временем: заголовок разбирается как раньше.
 */
export function appendLog(log: string | null, ctx: Pick<OpContext, 'stamp' | 'by'>, text: string): string {
  const [head, ...rest] = text.trim().split('\n');
  const when = ctx.by ? `${ctx.stamp} · ${ctx.by}` : ctx.stamp;
  const entry = [`## [${when}] ${head.trim()}`, ...rest].join('\n').trimEnd();
  const before = (log ?? '').trimEnd();
  return `${before ? `${before}\n\n` : ''}${entry}\n`;
}

/** Операции, которые пишут в журнал задачи, — им нужен автор. */
export function writesLog(op: Op): boolean {
  return op.kind === 'log' || op.kind === 'cancel' || op.kind === 'move' || op.kind === 'block';
}

/** Журнал у всей команды — в одном поясе, где бы ни стояла машина (владелец 19.10.2026). */
export const LOG_TIME_ZONE = 'Europe/Moscow';

/**
 * Дата задачи по Москве — `created`, `updated`, `revised`, месяц архива: у
 * всей команды один день, как и в журнале (владелец 19.10.2026).
 */
export function taskDate(at: Date, timeZone = LOG_TIME_ZONE): string {
  return logStamp(at, timeZone).slice(0, 10);
}

/** Время для журнала задачи — `2026-10-19 15:53:13 +03:00`. */
export function logStamp(at: Date, timeZone = LOG_TIME_ZONE): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offset = Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  const abs = Math.abs(offset);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ── пункты ───────────────────────────────────────────────────────────────

const ITEM_RE = /^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]*)(.*)$/;
const LIST_START_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING_RE = /^#{1,6}[ \t]+/;
const FENCE_RE = /^\s*(```|~~~)/;

interface BodyItem {
  line: number;
  text: string;
  checked: boolean;
}

/**
 * Обратные кавычки и знаки препинания не различаем: кавычки в оболочке приходится экранировать,
 * а «сообщает сколько» должно находить «сообщает, сколько» (испытание 30.09).
 */
function normalizeItem(text: string): string {
  return text.replace(/`/g, '').replace(/[.,;:!?…«»"'()]|\s[—–-]\s/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
}

/** Пункты `- [ ]` тела с текстом, склеенным из строк-продолжений (как в чек-листах карточки). */
export function bodyItems(body: string): BodyItem[] {
  const lines = body.split('\n');
  const items: BodyItem[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ITEM_RE.exec(lines[i]);
    if (!m) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    const parts = [m[4].trim()];
    let j = i;
    while (
      j + 1 < lines.length &&
      lines[j + 1].trim() !== '' &&
      !LIST_START_RE.test(lines[j + 1]) &&
      !HEADING_RE.test(lines[j + 1]) &&
      lines[j + 1].length - lines[j + 1].trimStart().length > indent
    ) {
      parts.push(lines[++j].trim());
    }
    items.push({ line: i, text: parts.join(' ').trim(), checked: m[2] !== ' ' });
  }
  return items;
}

export type ItemMatch = { item: string } | { error: string };

/**
 * Пункт по словам человека или агента: точный текст, иначе единственный
 * пункт, содержащий эти слова. Регистр и «ё» не важны.
 */
export function matchItem(body: string, query: string): ItemMatch {
  const items = bodyItems(body);
  const q = normalizeItem(query);
  if (!q) return { error: 'пустой текст пункта' };
  const exact = items.filter((i) => normalizeItem(i.text) === q);
  const hits = exact.length > 0 ? exact : items.filter((i) => normalizeItem(i.text).includes(q));
  if (hits.length === 1) return { item: hits[0].text };
  if (hits.length === 0) {
    const open = items.filter((i) => !i.checked).map((i) => `  - ${i.text}`);
    return { error: `нет пункта «${query}».${open.length > 0 ? ` Неотмеченные пункты:\n${open.join('\n')}` : ' Неотмеченных пунктов нет.'}` };
  }
  return { error: `«${query}» подходит к нескольким пунктам:\n${hits.map((i) => `  - ${i.text}`).join('\n')}\nУточните текст.` };
}

function setItems(body: string, texts: readonly string[], value: boolean): { body: string; changed: number } | { error: string } {
  const lines = body.split('\n');
  const items = bodyItems(body);
  let changed = 0;
  for (const text of texts) {
    const hit = items.find((i) => i.text === text);
    if (!hit) return { error: `нет пункта «${text}»` };
    if (hit.checked === value) continue;
    lines[hit.line] = lines[hit.line].replace(ITEM_RE, (_all, a: string, _mark: string, b: string, rest: string) => `${a}${value ? 'x' : ' '}${b}${rest}`);
    changed += 1;
  }
  return { body: lines.join('\n'), changed };
}

// ── вложения ─────────────────────────────────────────────────────────────

/** Вложения больше — не в задачи: репозиторий задач загружают целиком. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export { JOURNAL_FILE };

/**
 * Что не так с именем вложения; `null` — годится. Имя — относительный путь
 * внутри папки вложений задачи: без выхода наружу и без знаков, которые
 * ломают ссылки и оболочку.
 */
export function attachmentNameProblem(name: string): string | null {
  if (!name.trim()) return 'пустое имя файла';
  if (name.length > 200) return 'имя файла длиннее 200 знаков';
  if (name.toLowerCase() === JOURNAL_FILE.toLowerCase()) return `${JOURNAL_FILE} — так в карточке Kaiten называется журнал задачи, выберите другое имя`;
  if (name.includes('\\')) return 'в имени файла — прямой слэш, не обратный';
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'имя файла — без «..», «.» и слэша в начале или в конце';
  if (parts.length > 3) return 'не больше двух вложенных папок';
  if (!parts.every((p) => /^[\p{L}\p{N}_][\p{L}\p{N} ._()-]*$/u.test(p))) return 'в имени файла — буквы, цифры, пробел, точка, дефис, подчёркивание и скобки';
  return null;
}

// ── slug ─────────────────────────────────────────────────────────────────

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Slug из заголовка: латиница через дефис, до ~50 знаков по границе слова. */
export function slugify(title: string): string {
  const latin = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('');
  const words = latin.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 50 && slug) break;
    slug = next;
  }
  return slug.slice(0, 60);
}

export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function takenSlugs(texts: TaskTexts): Set<string> {
  const out = new Set<string>();
  for (const path of texts.keys()) if (path.endsWith('.md') && !path.endsWith('.log.md') && !isFindingPath(path)) out.add(path.split('/').at(-1)?.replace(/\.md$/, '') ?? '');
  return out;
}

// ── новая задача ─────────────────────────────────────────────────────────

export interface NewTaskInput {
  id: string;
  slug: string;
  title: string;
  summary: string;
  type: TaskType;
  repo?: string;
  epic?: string;
  /** Связанные задачи (slug): например, та, по ходу которой завели эту. */
  related?: string[];
  createdBy: string;
  createdVia: 'agent' | 'human';
  /** Тело; без него — скелет по типу. */
  body?: string;
  /** Подтверждённая находка — сразу в «Находки»; иначе «Входящие». */
  found?: boolean;
}

/** Файл новой задачи: во «Входящих» (находка — в «Находках»), без приоритета — его ставят при разборе. */
export function newTaskText(input: NewTaskInput, date: string): string | { error: string } {
  const parsed = FrontmatterSchema.safeParse({
    id: input.id,
    title: input.title,
    summary: input.summary,
    type: input.type,
    status: input.found ? 'found' : 'inbox',
    repo: input.repo,
    epic: input.epic,
    related: input.related,
    created: date,
    created_by: input.createdBy,
    created_via: input.createdVia,
    updated: date,
    revised: date,
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  // Пустой пункт скелета — заготовка для редактора; в задаче он был бы пустым пунктом чек-листа.
  const body = input.body?.trim() ? `${input.body.trim()}\n` : renderSkeleton(input.type).replace(/^- \[ \] \n/gm, '');
  return finalize(parsed.data, body, date);
}

// ── применение операции ──────────────────────────────────────────────────

export function applyOp(op: Op, texts: TaskTexts, ctx: OpContext): OpResult {
  if (op.kind === 'new') {
    const wanted = op.path.split('/').at(-1)?.replace(/\.md$/, '') ?? '';
    if (!SLUG_RE.test(wanted)) return { error: 'имя задачи — только латиница через дефис' };
    // Имя ещё не отправленной задачи не свято: если его успел занять другой,
    // задача получает следующее свободное, а не пропадает.
    const slug = uniqueSlug(wanted, takenSlugs(texts));
    const path = `active/${slug}.md`;
    const result = checked(op.text, path);
    if ('error' in result) return result;
    const id = parseTaskDocument(op.text).data as { id?: string };
    if (records(texts).some((t) => t.fm.id === id.id)) return { error: 'задача с таким id уже есть' };
    const renamed = slug === wanted ? '' : ` (имя ${wanted} было занято)`;
    return { changes: [{ path, text: op.text }], summary: `новая задача ${slug}${renamed}`, warnings: result.warnings };
  }

  if (op.kind === 'found-note') {
    const path = findingPath(op.id);
    if (texts.has(path)) return { error: 'такая находка уже записана' };
    const parsed = parseFinding(op.text);
    if ('error' in parsed) return { error: parsed.error };
    return { changes: [{ path, text: op.text }], summary: `находка записана: ${parsed.title}`, warnings: [] };
  }
  if (op.kind === 'found-verdict') return applyFoundVerdict(op, texts, ctx);

  if (op.kind === 'synced') return applySynced(op.items, texts);
  if (op.kind === 'mirror') return applyMirror(op.items, texts, ctx);
  if (op.kind === 'adopt') return applyAdopt(op.items, texts);
  if (op.kind === 'assessed') return applyAssessed(op.items, texts, ctx);
  if (op.kind === 'sync-version') {
    const changes = parseSyncVersion(texts.get(SYNC_VERSION_FILE)) >= op.version ? [] : [{ path: SYNC_VERSION_FILE, text: renderSyncVersion(op.version) }];
    return { changes, summary: `версия синхронизации ${op.version}`, warnings: [] };
  }

  const task = byId(texts, op.id);
  if ('error' in task) return task;
  const ref = refOf(task);

  switch (op.kind) {
    case 'check': {
      const next = setItems(task.body, op.items, op.checked);
      if ('error' in next) return next;
      if (next.changed === 0) return { changes: [], summary: `пункты ${ref} уже ${op.checked ? 'отмечены' : 'сняты'}`, warnings: [] };
      const out = write(task, task.fm, next.body, ctx);
      if ('error' in out) return out;
      return { changes: [{ path: task.path, text: out.text }], summary: `${op.checked ? 'отмечено' : 'снято'} пунктов в ${ref}: ${next.changed}`, warnings: [] };
    }
    case 'log': {
      if (!op.text.trim()) return { error: 'пустая запись журнала' };
      return { changes: [{ path: logPath(task.path), text: appendLog(task.log, ctx, op.text) }], summary: `запись в журнал ${ref}`, warnings: [] };
    }
    case 'cancel': {
      if (!CANCELLABLE.includes(task.fm.status)) {
        return { error: `задача ${ref} в статусе ${task.fm.status}: отменить можно только из ${CANCELLABLE.join(', ')}` };
      }
      if (!op.reason.trim()) return { error: 'укажите причину отмены' };
      const archived = `archive/${ctx.date.slice(0, 7)}/${task.slug}.md`;
      const out = write(task, { ...task.fm, status: 'cancelled', ...withQueued(task, op.queued) }, task.body, ctx, archived);
      if ('error' in out) return out;
      // Файл переезжает один раз за жизнь задачи (Q42) — вместе с журналом.
      const changes: FileChange[] = [{ path: task.path, text: null }];
      if (task.log !== null) changes.push({ path: logPath(task.path), text: null });
      changes.push({ path: archived, text: out.text }, { path: logPath(archived), text: appendLog(task.log, ctx, `отменена: ${op.reason.trim()}${op.queued ? QUEUED_NOTE : ''}`) });
      return { changes, summary: `задача ${ref} отменена`, warnings: [] };
    }
    case 'move': {
      const problem = moveProblem(task, op.status, op.assigned === true);
      if (problem) return { error: problem };
      if (task.fm.status === op.status) return { changes: [], summary: `задача ${ref} уже ${MOVE_WORDS[op.status]}`, warnings: [] };
      const from = op.status === 'in-progress' ? ASSIGNED_FROM[task.fm.status] : undefined;
      const priority = op.status === 'in-progress' ? assignedPriority(task, op.assigned === true) : undefined;
      const assignedNote = from ? ` (из ${from}, по прямому поручению${priority ? `, приоритет ${priority}` : ''})` : '';
      const entry = `${MOVE_WORDS[op.status]}${assignedNote}${op.note?.trim() ? `: ${op.note.trim()}` : ''}${op.queued ? QUEUED_NOTE : ''}`;
      const target = op.status === 'done' ? `archive/${ctx.date.slice(0, 7)}/${task.slug}.md` : task.path;
      const fm: Frontmatter = { ...task.fm, status: op.status, ...(op.branch ? { branch: op.branch } : {}), ...(priority ? { priority } : {}), ...(op.visual ? { visual: op.visual } : {}), ...withQueued(task, op.queued) };
      const out = write(task, fm, task.body, ctx, target);
      if ('error' in out) return out;
      const changes: FileChange[] = [];
      // Сделанная задача переезжает в архив вместе с журналом (Q42).
      if (target !== task.path) {
        changes.push({ path: task.path, text: null });
        if (task.log !== null) changes.push({ path: logPath(task.path), text: null });
      }
      changes.push({ path: target, text: out.text }, { path: logPath(target), text: appendLog(task.log, ctx, entry) });
      return { changes, summary: `задача ${ref} ${MOVE_WORDS[op.status]}`, warnings: [] };
    }
    case 'block': {
      if (!BLOCKABLE.includes(task.fm.status)) return { error: `задача ${ref} в статусе ${task.fm.status}: заблокировать можно только открытую` };
      if (!op.reason.trim()) return { error: 'укажите, что блокирует задачу' };
      const out = write(task, { ...task.fm, status: 'blocked', ...withQueued(task, op.queued) }, task.body, ctx);
      if ('error' in out) return out;
      return {
        changes: [
          { path: task.path, text: out.text },
          { path: logPath(task.path), text: appendLog(task.log, ctx, `заблокирована: ${op.reason.trim()}${op.queued ? QUEUED_NOTE : ''}`) },
        ],
        summary: `задача ${ref} заблокирована`,
        warnings: [],
      };
    }
    case 'attach': {
      const problem = attachmentNameProblem(op.name);
      if (problem) return { error: problem };
      if (!/^[0-9a-f]{40,64}$/.test(op.blob)) return { error: 'содержимое вложения не найдено' };
      return { changes: [{ path: `attachments/${task.slug}/${op.name}`, text: null, blob: op.blob }], summary: `вложение ${op.name} приложено к задаче ${ref}`, warnings: [] };
    }
    case 'detach': {
      if (op.names.length === 0) return { error: 'не названо, что убрать' };
      for (const name of op.names) {
        const problem = attachmentNameProblem(name);
        if (problem) return { error: problem };
        if (!isVisualAttachment(name)) return { error: `${name}: убрать можно только картинку «Было / Стало»` };
      }
      // Файла уже нет (убрали с другой машины) — git ничего не изменит, и запись выйдет пустой.
      const changes: FileChange[] = op.names.map((name) => ({ path: `attachments/${task.slug}/${name}`, text: null }));
      const summary = op.names.length === 1 ? `вложение ${op.names[0]} убрано из задачи ${ref}` : `из задачи ${ref} убрано вложений: ${op.names.length}`;
      return { changes, summary, warnings: [] };
    }
    case 'edit': {
      if (contentHash(task.fm, task.body) !== op.baseHash) {
        return { error: `задачу ${ref} изменили одновременно с вами — правка не применена` };
      }
      let raw;
      try {
        raw = parseTaskDocument(op.text);
      } catch (error) {
        if (error instanceof TaskParseError) return { error: error.message };
        throw error;
      }
      const parsed = FrontmatterSchema.safeParse(raw.data);
      if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join('.') || '(шапка)'}: ${i.message}`).join('; ') };
      const foreign = foreignFieldChanges(task.fm, parsed.data).filter((f) => f !== 'updated' && f !== 'revised' && f !== 'content_hash' && f !== 'files_hash');
      if (foreign.length > 0) return { error: `эти поля правятся не в тексте задачи: ${foreign.join(', ')} — верните их как были` };
      // Поля не-файла не тронуты, значит «изменилось ли» решает хеш файловой части.
      if (contentHash(parsed.data, raw.body) === op.baseHash) return { changes: [], summary: `задача ${ref} без изменений`, warnings: [] };
      // «Доставлено в Kaiten» правкой не подделать: берётся из задачи, не из текста.
      const out = write(task, { ...parsed.data, revised: ctx.date, content_hash: task.fm.content_hash, files_hash: task.fm.files_hash }, raw.body, ctx);
      if ('error' in out) return out;
      return { changes: [{ path: task.path, text: out.text }], summary: `задача ${ref} изменена`, warnings: out.warnings };
    }
  }
}

/**
 * Вердикт исследования — в заметку; подтверждённая находка тем же шагом
 * становится задачей в «Находках». Имя задачи занято — следующее свободное,
 * как у `new`: заметка называет то имя, под которым задача записана.
 */
function applyFoundVerdict(op: Extract<Op, { kind: 'found-verdict' }>, texts: TaskTexts, ctx: OpContext): OpResult {
  const path = findingPath(op.id);
  const text = texts.get(path);
  if (text === undefined) return { error: 'находки больше нет среди находок проекта' };
  const finding = parseFinding(text);
  if ('error' in finding) return { error: `заметка о находке не читается: ${finding.error}` };
  if (finding.fm.state !== 'pending') return { changes: [], summary: 'находка уже исследована', warnings: [] };
  if (!op.reason.trim()) return { error: 'вердикт без причины' };

  const changes: FileChange[] = [];
  let warnings: string[] = [];
  let task: string | undefined;
  if (op.state === 'confirmed') {
    if (!op.task?.text || !SLUG_RE.test(op.task.slug)) return { error: 'подтверждённая находка без задачи' };
    const slug = uniqueSlug(op.task.slug, takenSlugs(texts));
    const taskPath = `active/${slug}.md`;
    const result = checked(op.task.text, taskPath);
    if ('error' in result) return result;
    const { id } = parseTaskDocument(op.task.text).data as { id?: string };
    if (records(texts).some((t) => t.fm.id === id)) return { error: 'задача с таким id уже есть' };
    changes.push({ path: taskPath, text: op.task.text });
    warnings = result.warnings;
    task = slug;
  } else if (op.state === 'duplicate') {
    if (!op.task || !records(texts).some((t) => t.slug === op.task?.slug)) return { error: 'задачи, повтором которой названа находка, больше нет' };
    task = op.task.slug;
  }
  changes.push({ path, text: serializeFinding({ ...finding, fm: { ...finding.fm, state: op.state, resolved: ctx.date, ...(task ? { task } : {}) }, reason: op.reason.trim() }) });
  const what = op.state === 'confirmed' ? `подтверждена — задача ${task}` : op.state === 'duplicate' ? `уже записана в задаче ${task}` : 'не подтверждена';
  return { changes, summary: `находка ${what}`, warnings };
}

/**
 * Отметки синхронизации пакетом. Задача, которой уже нет (отменили и
 * удалили — не бывает, но и не повод терять остальные), пропускается.
 */
/**
 * Поля Kaiten — в файлы пакетом. Задача, для которой зеркало дало бы битый
 * файл (например, эпик с полем `epic`), пропускается с подсказкой — остальные
 * записываются.
 */
function applyMirror(items: readonly MirrorItem[], texts: TaskTexts, ctx: OpContext): OpResult {
  const all = records(texts);
  const changes: FileChange[] = [];
  const warnings: string[] = [];
  let count = 0;
  for (const item of items) {
    const task = all.find((x) => x.fm.id === item.id);
    if (!task) continue;
    const fm: Frontmatter = { ...task.fm };
    if (item.status !== undefined) fm.status = item.status;
    if (item.type !== undefined) fm.type = item.type;
    if (item.priority !== undefined) fm.priority = item.priority ?? undefined;
    if (item.team !== undefined) fm.team = item.team ?? undefined;
    if (item.assessment !== undefined) fm.assessment = item.assessment ?? undefined;
    if (item.due !== undefined) {
      const planning = { ...(fm.planning ?? {}), due: item.due ?? undefined };
      if (planning.due === undefined) delete planning.due;
      fm.planning = Object.values(planning).some((v) => v !== undefined && v !== null) ? planning : undefined;
    }
    if (item.settled !== undefined && fm.pending_moves) {
      const { steps } = fm.pending_moves;
      const left = item.settled === 'all' ? [] : steps.slice(item.settled);
      if (left.length === 0) delete fm.pending_moves;
      else fm.pending_moves = { ...fm.pending_moves, from: steps[steps.length - left.length - 1]?.status ?? fm.pending_moves.from, steps: left };
    }
    const closed = CLOSED_STATUSES.includes(fm.status);
    const inArchive = task.path.startsWith('archive/');
    let path = task.path;
    if (closed && !inArchive) path = `archive/${item.closedMonth ?? ctx.date.slice(0, 7)}/${task.slug}.md`;
    if (!closed && inArchive) path = `active/${task.slug}.md`;
    const out = write(task, fm, task.body, ctx, path);
    if ('error' in out) {
      warnings.push(`${refOf(task)}: поля из Kaiten не записаны — ${out.error}`);
      continue;
    }
    count += 1;
    const log = item.note ? appendLog(task.log, ctx, item.note) : task.log;
    if (path === task.path) {
      changes.push({ path, text: out.text });
      if (item.note) changes.push({ path: logPath(path), text: log });
      continue;
    }
    changes.push({ path: task.path, text: null }, { path, text: out.text });
    if (task.log !== null) changes.push({ path: logPath(task.path), text: null });
    if (log !== null) changes.push({ path: logPath(path), text: log });
  }
  return { changes, summary: `из Kaiten: задач ${count}`, warnings };
}

function applyAdopt(items: readonly AdoptItem[], texts: TaskTexts): OpResult {
  const ids = new Set(records(texts).map((t) => t.fm.id));
  const taken = takenSlugs(texts);
  const changes: FileChange[] = [];
  const warnings: string[] = [];
  for (const item of items) {
    const { id } = parseTaskDocument(item.text).data as { id?: string };
    // Сначала id, потом имя: иначе повтор той же карточки стал бы задачей «slug-2».
    if (id === undefined || ids.has(id)) continue;
    const slug = uniqueSlug(item.slug, taken);
    const path = item.closedMonth ? `archive/${item.closedMonth}/${slug}.md` : `active/${slug}.md`;
    const result = checked(item.text, path);
    if ('error' in result) {
      warnings.push(`${slug}: карточка не перенесена — ${result.error}`);
      continue;
    }
    ids.add(id);
    taken.add(slug);
    changes.push({ path, text: item.text });
  }
  return { changes, summary: `из Kaiten новых задач: ${changes.length}`, warnings };
}

function applyAssessed(items: ReadonlyArray<{ id: string; verdict: AssessVerdict }>, texts: TaskTexts, ctx: OpContext): OpResult {
  const all = records(texts);
  const changes: FileChange[] = [];
  for (const item of items) {
    const task = all.find((x) => x.fm.id === item.id);
    if (!task) continue;
    const fm: Frontmatter = { ...task.fm, assessment: item.verdict, assessed: { verdict: item.verdict, date: ctx.date } };
    changes.push({ path: task.path, text: serializeTaskDocument(fm, task.body) });
  }
  return { changes, summary: `оценки: ${changes.length}`, warnings: [] };
}

function applySynced(items: readonly SyncedItem[], texts: TaskTexts): OpResult {
  const all = records(texts);
  const changes: FileChange[] = [];
  for (const item of items) {
    const task = all.find((x) => x.fm.id === item.id);
    if (!task) continue;
    const fm: Frontmatter = {
      ...task.fm,
      content_hash: item.contentHash,
      ...(item.filesHash ? { files_hash: item.filesHash } : {}),
      ...(item.tracker ? { tracker: item.tracker } : {}),
      ...(item.team ? { team: item.team } : {}),
    };
    if (fm.content_hash === task.fm.content_hash && fm.files_hash === task.fm.files_hash && fm.tracker === task.fm.tracker && fm.team === task.fm.team) continue;
    changes.push({ path: task.path, text: serializeTaskDocument(fm, task.body) });
  }
  return { changes, summary: `отметки Kaiten: ${changes.length}`, warnings: [] };
}

/** Задача по ссылке в текстах — для команд, которым нужно состояние до операции. */
export function tasksOf(texts: TaskTexts): TaskRecord[] {
  return records(texts);
}
