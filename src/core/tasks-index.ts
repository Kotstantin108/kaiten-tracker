/**
 * Задачи проекта в памяти — основа команд чтения CLI `kaiten` (`show`,
 * `list`, `search`). Чистый модуль: получает тексты файлов, ни диска, ни git,
 * ни сети не знает. Команды чтения работают по локальному клону без сети
 * (Q10); Kaiten они не читают.
 *
 * Битый файл не роняет чтение: он попадает в `problems` с тем, что в нём
 * исправить, а остальные задачи читаются как обычно.
 *
 * ССЫЛКА НА ЗАДАЧУ (`ref`) — что угодно, чем её называют люди и агенты:
 * ключ карточки (`PRJ-123`, регистр неважен) или её числовой id, пока ключей
 * пространств нет; `id` (ULID) и slug — имя файла без `.md`.
 */

import { extractChecklists, withoutAgentPrefix } from '../checklists.js';
import { parseTaskDocument, TaskParseError } from './document.js';
import { schemaError, type TaskFileText } from './lint.js';
import { CLOSED_STATUSES, FrontmatterSchema, PRIORITIES, STATUSES, type Frontmatter, type TaskStatus, type TaskType } from './schema.js';

export interface TaskRecord {
  /** Путь относительно корня репозитория задач. */
  path: string;
  slug: string;
  fm: Frontmatter;
  body: string;
  /** Журнал `<slug>.log.md`, если есть. */
  log: string | null;
  closed: boolean;
}

export interface TaskProblem {
  path: string;
  message: string;
}

export interface TaskIndex {
  tasks: TaskRecord[];
  problems: TaskProblem[];
}

export function slugOf(path: string): string {
  return (path.replace(/\\/g, '/').split('/').at(-1) ?? '').replace(/\.md$/, '');
}

export function buildIndex(files: readonly TaskFileText[], logs: ReadonlyMap<string, string> = new Map()): TaskIndex {
  const tasks: TaskRecord[] = [];
  const problems: TaskProblem[] = [];
  for (const file of files) {
    let raw;
    try {
      raw = parseTaskDocument(file.text);
    } catch (error) {
      if (!(error instanceof TaskParseError)) throw error;
      problems.push({ path: file.path, message: error.message });
      continue;
    }
    const parsed = FrontmatterSchema.safeParse(raw.data, { error: schemaError });
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '(шапка)'}: ${i.message}`).join('; ');
      problems.push({ path: file.path, message });
      continue;
    }
    tasks.push({
      path: file.path,
      slug: slugOf(file.path),
      fm: parsed.data,
      body: raw.body,
      log: logs.get(file.path) ?? null,
      closed: CLOSED_STATUSES.includes(parsed.data.status),
    });
  }
  return { tasks, problems };
}

/**
 * Задачи того ли проекта: хоть одна задача с `repo` должна указывать на
 * репозиторий проекта. Иначе `TASKS_DIR`, заданный под другой проект, дал бы
 * чужие задачи под именем этого — уверенно и молча. Пустой клон и клон из
 * одних эпиков без `repo` проходят: проверить нечем.
 */
export function belongsToProject(tasks: readonly TaskRecord[], repos: readonly string[]): boolean {
  const withRepo = tasks.filter((t) => t.fm.repo !== undefined);
  return withRepo.length === 0 || withRepo.some((t) => repos.includes(t.fm.repo as string));
}

/** Короткое имя задачи для вывода: ключ карточки, а пока его нет — slug. */
export function refOf(task: TaskRecord): string {
  return task.fm.tracker ?? task.slug;
}

function sameRef(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function matchesRef(task: TaskRecord, ref: string): boolean {
  const r = ref.trim();
  return (task.fm.tracker !== undefined && sameRef(task.fm.tracker, r)) || sameRef(task.fm.id, r) || task.slug === r.toLowerCase();
}

export type Resolved = { task: TaskRecord } | { error: string };

export function resolveTask(tasks: readonly TaskRecord[], ref: string): Resolved {
  const hits = tasks.filter((t) => matchesRef(t, ref));
  if (hits.length === 1) return { task: hits[0] };
  if (hits.length === 0) return { error: `Задачи «${ref}» нет. Найти её: kaiten search <слова>` };
  return { error: `«${ref}» подходит к нескольким задачам: ${hits.map((t) => t.slug).join(', ')}. Уточните slug.` };
}

/** Эпик задачи: поле `epic` ссылается на ключ карточки эпика или его `id`. */
export function epicOf(tasks: readonly TaskRecord[], task: TaskRecord): TaskRecord | null {
  const ref = task.fm.epic;
  if (ref === undefined) return null;
  return tasks.find((t) => t.fm.type === 'epic' && (sameRef(t.fm.id, ref) || (t.fm.tracker !== undefined && sameRef(t.fm.tracker, ref)))) ?? null;
}

export function childrenOf(tasks: readonly TaskRecord[], epic: TaskRecord): TaskRecord[] {
  return tasks.filter((t) => t !== epic && epicOf(tasks, t) === epic);
}

export interface ChecklistProgress {
  /** Раздел задачи: «Критерии готовности», «Шаги». */
  name: string;
  done: number;
  total: number;
}

/** Пункты `- [ ]` тела по разделам — те же, что уезжают в чек-листы карточки. */
export function checklistProgress(body: string): ChecklistProgress[] {
  return extractChecklists(body).checklists.map((c) => ({
    name: withoutAgentPrefix(c.name),
    done: c.items.filter((i) => i.checked).length,
    total: c.items.length,
  }));
}

export interface TaskFilter {
  /** Репозиторий кода. Эпик без `repo` проходит, если в этом репозитории есть его задача. */
  repo?: string;
  epic?: TaskRecord;
  statuses?: readonly TaskStatus[];
  types?: readonly TaskType[];
  /** Показывать и закрытые (`done`, `cancelled`). Явный `statuses` сильнее. */
  closed?: boolean;
}

export function filterTasks(tasks: readonly TaskRecord[], filter: TaskFilter): TaskRecord[] {
  return tasks.filter((t) => {
    if (filter.statuses && filter.statuses.length > 0) {
      if (!filter.statuses.includes(t.fm.status)) return false;
    } else if (t.closed && !filter.closed) {
      return false;
    }
    if (filter.types && filter.types.length > 0 && !filter.types.includes(t.fm.type)) return false;
    if (filter.epic && epicOf(tasks, t) !== filter.epic) return false;
    if (filter.repo !== undefined && t.fm.repo !== filter.repo) {
      if (t.fm.type !== 'epic' || t.fm.repo !== undefined) return false;
      if (!childrenOf(tasks, t).some((c) => c.fm.repo === filter.repo)) return false;
    }
    return true;
  });
}

const rank = <T>(list: readonly T[], value: T | undefined): number => {
  const i = value === undefined ? -1 : list.indexOf(value);
  return i === -1 ? list.length : i;
};

/** По колонке доски, затем приоритет (без приоритета — в конце), затем старые раньше. */
export function sortTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort(
    (a, b) =>
      rank(STATUSES, a.fm.status) - rank(STATUSES, b.fm.status) ||
      rank(PRIORITIES, a.fm.priority) - rank(PRIORITIES, b.fm.priority) ||
      a.fm.created.localeCompare(b.fm.created) ||
      a.slug.localeCompare(b.slug),
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

/** Строка задачи, показанная поиском: где она (раздел тела, запись журнала, «Суть») и совпала ли сама. */
export interface MatchLine {
  where: string;
  text: string;
  /** `false` — соседняя строка, показанная для понимания. */
  hit: boolean;
  /** Перед строкой — разрыв: она не продолжает предыдущую показанную. */
  gap: boolean;
}

export interface SearchHit {
  task: TaskRecord;
  /** Строка тела или журнала с первым найденным словом; `null`, если всё нашлось в заголовке или «Сути». */
  snippet: string | null;
  /** Все совпавшие строки с соседними — когда их просили (`lines`). */
  lines?: MatchLine[];
}

export interface SearchOptions {
  /** Запрос — одно регулярное выражение (без регистра, построчно), а не слова. */
  regex?: boolean;
  /** Слова искать как написаны, не отбрасывая окончаний. */
  exact?: boolean;
  /** Вернуть все совпавшие строки задачи, а не одну. */
  lines?: boolean;
  /** Сколько соседних строк показать вокруг совпавшей. */
  context?: number;
  /** Текстовые вложения по slug задачи: в них тоже ищется. */
  attachments?: ReadonlyMap<string, ReadonlyArray<{ name: string; text: string }>>;
}

/** Запрос не разобрать (кривое выражение) — словами для человека. */
export class SearchQueryError extends Error {}

/**
 * Окончания, которые отбрасываются у русского слова запроса: «пустом» находит
 * «пустого», «онбордингом» — «онбординг». Не морфология, а обрезка: ищем всё
 * равно подстрокой, и лишняя находка дешевле пропущенной задачи.
 */
const ENDINGS = [
  'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'иях', 'ией', 'ием',
  'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ую', 'юю', 'ть',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];
const STEM_MIN = 4;

export function stem(word: string): string {
  if (!/^[а-я]+$/.test(word)) return word;
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= STEM_MIN) return word.slice(0, -ending.length);
  }
  return word;
}

/** Проверка одной строки (или всего текста) на одно условие запроса. */
type Term = (normalized: string) => boolean;

/**
 * Условия запроса. Слова: каждое обязательно; `a|b` внутри слова — любой из
 * вариантов. Выражение: одно условие на весь запрос.
 */
function termsOf(query: string, options: SearchOptions): Term[] {
  if (options.regex) {
    let re: RegExp;
    try {
      // Текст приведён к нижнему регистру — выражение сравниваем без регистра; «ё» = «е» с обеих сторон.
      re = new RegExp(query.replace(/ё/g, 'е').replace(/Ё/g, 'Е'), 'imu');
    } catch (error) {
      // Сообщение движка: «Invalid regular expression: /…/: причина» — человеку нужна причина.
      throw new SearchQueryError(`выражение не разобрать (${(error instanceof Error ? error.message : String(error)).split(': ').at(-1)})`);
    }
    return [(text) => re.test(text)];
  }
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const variants = word.split('|').filter(Boolean).map((v) => (options.exact ? v : stem(v)));
      return (text: string) => variants.some((v) => text.includes(v));
    });
}

interface SourceLine {
  where: string;
  text: string;
}

const SEARCH_HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Строки задачи с подписью, откуда они: «Суть», раздел тела, запись журнала. */
function sourceLines(task: TaskRecord, attachments: ReadonlyArray<{ name: string; text: string }> = []): SourceLine[][] {
  const summary: SourceLine[] = [{ where: 'Суть', text: task.fm.summary }];
  const body: SourceLine[] = [];
  let section = 'постановка';
  for (const line of task.body.split('\n')) {
    const heading = SEARCH_HEADING_RE.exec(line);
    if (heading) section = heading[1].replace(/[*_`]/g, '').trim();
    body.push({ where: section, text: line });
  }
  const log: SourceLine[] = [];
  let entry = 'журнал';
  for (const line of (task.log ?? '').split('\n')) {
    // `## [2026-09-28]` и `## [2026-10-19 21:43:26 +03:00 · alice]` — подпись по дате.
    const date = /^## \[(\d{4}-\d{2}-\d{2})[ \]]/.exec(line);
    if (date) entry = `журнал ${date[1]}`;
    log.push({ where: entry, text: line });
  }
  const files = attachments.map((a) => a.text.split(/\r?\n/).map((text) => ({ where: `вложение ${a.name}`, text })));
  return [summary, body, log, ...files];
}

function matchLines(task: TaskRecord, terms: readonly Term[], context: number, attachments: ReadonlyArray<{ name: string; text: string }> = []): MatchLine[] {
  const out: MatchLine[] = [];
  for (const source of sourceLines(task, attachments)) {
    const hits = source.map((l) => l.text.trim() !== '' && terms.some((t) => t(normalize(l.text))));
    // Источники (суть, тело, журнал) друг друга не продолжают: первая строка каждого — после разрыва.
    let last = -2;
    for (let i = 0; i < source.length; i += 1) {
      const near = hits.slice(Math.max(0, i - context), i + context + 1).some(Boolean);
      if (!near || source[i].text.trim() === '') continue;
      out.push({ where: source[i].where, text: source[i].text.trim(), hit: hits[i], gap: out.length > 0 && last !== i - 1 });
      last = i;
    }
  }
  return out;
}

/**
 * Поиск по заголовку, «Сути», телу, журналу, slug и ключу; регистр и «ё» не
 * важны. Слова: нужны все, у русских слов окончания отбрасываются, `a|b` —
 * любой из вариантов. `regex` — одно выражение на запрос. Совпавшие по
 * заголовку — выше.
 */
export function searchTasks(tasks: readonly TaskRecord[], query: string, options: SearchOptions = {}): SearchHit[] {
  const terms = termsOf(query, options);
  if (terms.length === 0) return [];
  const hits: Array<SearchHit & { score: number }> = [];
  for (const task of tasks) {
    const head = normalize(`${task.fm.title}\n${task.fm.summary}\n${task.slug}\n${task.fm.tracker ?? ''}`);
    const files = options.attachments?.get(task.slug) ?? [];
    const rest = normalize(`${task.body}\n${task.log ?? ''}\n${files.map((f) => f.text).join('\n')}`);
    if (!terms.every((t) => t(head) || t(rest))) continue;
    const title = normalize(task.fm.title);
    const score = terms.filter((t) => t(title)).length * 2 + terms.filter((t) => t(head)).length;
    const missing = terms.find((t) => !t(head));
    let snippet: string | null = null;
    if (missing) {
      // Строка целиком: обрезает вывод — после того, как ссылки в ней заменены командами.
      snippet = (`${task.body}\n${task.log ?? ''}`.split('\n').find((l) => missing(normalize(l))) ?? '').trim();
      if (!snippet) {
        // Нашлось только во вложении — так и подписать: иначе непонятно, где искать.
        for (const f of files) {
          const line = f.text.split(/\r?\n/).find((l) => missing(normalize(l)));
          if (line !== undefined) {
            snippet = `вложение ${f.name}: ${line.trim()}`;
            break;
          }
        }
      }
    }
    const hit: SearchHit & { score: number } = { task, snippet, score };
    if (options.lines) hit.lines = matchLines(task, terms, Math.max(0, options.context ?? 0), files);
    hits.push(hit);
  }
  const order = new Map(sortTasks(hits.map((h) => h.task)).map((t, i) => [t, i]));
  return hits
    .sort((a, b) => b.score - a.score || (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0))
    .map(({ score: _score, ...hit }) => hit);
}
