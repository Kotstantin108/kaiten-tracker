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
 * Статусы. CLI ставит только `cancelled` и `blocked` (и `inbox` новой
 * задаче); `in-progress`/`review`/`done` двигает интеграция Kaiten ↔ GitHub
 * (решение 5, Q30, Q33). Отмена — только из «Входящих», «Бэклога» и «Готово к
 * работе»: так же, как ограничение на доске (28.09).
 */

import { contentHash, foreignFieldChanges, parseTaskDocument, serializeTaskDocument, TaskParseError } from './document.js';
import { lintTask, SLUG_RE } from './lint.js';
import { FrontmatterSchema, type Frontmatter, type TaskStatus, type TaskType } from './schema.js';
import { renderSkeleton } from './skeleton.js';
import { buildIndex, refOf, type TaskRecord } from './tasks-index.js';

export type Op =
  | { kind: 'new'; path: string; text: string }
  | { kind: 'check'; id: string; items: string[]; checked: boolean }
  | { kind: 'log'; id: string; text: string }
  | { kind: 'cancel'; id: string; reason: string }
  | { kind: 'block'; id: string; reason: string }
  | { kind: 'edit'; id: string; text: string; baseHash: string };

export interface OpContext {
  /** Дата операции `YYYY-MM-DD` — из журнала, не «сегодня». */
  date: string;
}

/** Файлы задач в памяти: путь → текст (задачи и журналы под active/ и archive/). */
export type TaskTexts = ReadonlyMap<string, string>;

export interface FileChange {
  path: string;
  /** `null` — файл удаляется (перенос в архив). */
  text: string | null;
}

export type OpResult = { changes: FileChange[]; summary: string; warnings: string[] } | { error: string };

export const CANCELLABLE: readonly TaskStatus[] = ['inbox', 'backlog', 'ready'];
export const BLOCKABLE: readonly TaskStatus[] = ['inbox', 'backlog', 'ready', 'in-progress', 'review'];

// ── чтение состояния ─────────────────────────────────────────────────────

function records(texts: TaskTexts): TaskRecord[] {
  const files: Array<{ path: string; text: string }> = [];
  const logs = new Map<string, string>();
  for (const [path, text] of texts) {
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

/** Файл, который пишет CLI: служебные поля обновлены, текст канонический. */
function finalize(fm: Frontmatter, body: string, date: string): string {
  const next: Frontmatter = { ...fm, updated: date };
  next.content_hash = contentHash(next, body);
  return serializeTaskDocument(next, body);
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

/**
 * Запись журнала `## [YYYY-MM-DD] заголовок` + текст, как у перенесённых
 * задач. Первая строка текста — заголовок, остальное — тело.
 */
export function appendLog(log: string | null, date: string, text: string): string {
  const [head, ...rest] = text.trim().split('\n');
  const entry = [`## [${date}] ${head.trim()}`, ...rest].join('\n').trimEnd();
  const before = (log ?? '').trimEnd();
  return `${before ? `${before}\n\n` : ''}${entry}\n`;
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

function normalizeItem(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
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
  for (const path of texts.keys()) if (!path.endsWith('.log.md')) out.add(path.split('/').at(-1)?.replace(/\.md$/, '') ?? '');
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
  createdBy: string;
  createdVia: 'agent' | 'human';
  /** Тело; без него — скелет по типу. */
  body?: string;
}

/** Файл новой задачи: во «Входящих», без приоритета — его ставят при разборе. */
export function newTaskText(input: NewTaskInput, date: string): string | { error: string } {
  const parsed = FrontmatterSchema.safeParse({
    id: input.id,
    title: input.title,
    summary: input.summary,
    type: input.type,
    status: 'inbox',
    repo: input.repo,
    epic: input.epic,
    created: date,
    created_by: input.createdBy,
    created_via: input.createdVia,
    updated: date,
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
      return { changes: [{ path: logPath(task.path), text: appendLog(task.log, ctx.date, op.text) }], summary: `запись в журнал ${ref}`, warnings: [] };
    }
    case 'cancel': {
      if (!CANCELLABLE.includes(task.fm.status)) {
        return { error: `задача ${ref} в статусе ${task.fm.status}: отменить можно только из ${CANCELLABLE.join(', ')}` };
      }
      if (!op.reason.trim()) return { error: 'укажите причину отмены' };
      const archived = `archive/${ctx.date.slice(0, 7)}/${task.slug}.md`;
      const out = write(task, { ...task.fm, status: 'cancelled' }, task.body, ctx, archived);
      if ('error' in out) return out;
      // Файл переезжает один раз за жизнь задачи (Q42) — вместе с журналом.
      const changes: FileChange[] = [{ path: task.path, text: null }];
      if (task.log !== null) changes.push({ path: logPath(task.path), text: null });
      changes.push({ path: archived, text: out.text }, { path: logPath(archived), text: appendLog(task.log, ctx.date, `отменена: ${op.reason.trim()}`) });
      return { changes, summary: `задача ${ref} отменена`, warnings: [] };
    }
    case 'block': {
      if (!BLOCKABLE.includes(task.fm.status)) return { error: `задача ${ref} в статусе ${task.fm.status}: заблокировать можно только открытую` };
      if (!op.reason.trim()) return { error: 'укажите, что блокирует задачу' };
      const out = write(task, { ...task.fm, status: 'blocked' }, task.body, ctx);
      if ('error' in out) return out;
      return {
        changes: [
          { path: task.path, text: out.text },
          { path: logPath(task.path), text: appendLog(task.log, ctx.date, `заблокирована: ${op.reason.trim()}`) },
        ],
        summary: `задача ${ref} заблокирована`,
        warnings: [],
      };
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
      const foreign = foreignFieldChanges(task.fm, parsed.data).filter((f) => f !== 'updated' && f !== 'content_hash');
      if (foreign.length > 0) return { error: `эти поля правятся не в тексте задачи: ${foreign.join(', ')} — верните их как были` };
      // Поля не-файла не тронуты, значит «изменилось ли» решает хеш файловой части.
      if (contentHash(parsed.data, raw.body) === op.baseHash) return { changes: [], summary: `задача ${ref} без изменений`, warnings: [] };
      const out = write(task, parsed.data, raw.body, ctx);
      if ('error' in out) return out;
      return { changes: [{ path: task.path, text: out.text }], summary: `задача ${ref} изменена`, warnings: out.warnings };
    }
  }
}

/** Задача по ссылке в текстах — для команд, которым нужно состояние до операции. */
export function tasksOf(texts: TaskTexts): TaskRecord[] {
  return records(texts);
}
