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

export interface SearchHit {
  task: TaskRecord;
  /** Строка тела или журнала с первым найденным словом; `null`, если всё нашлось в заголовке или «Сути». */
  snippet: string | null;
}

/**
 * Все слова запроса (без регистра, «ё» = «е») должны найтись в задаче:
 * заголовок, «Суть», тело, журнал, slug, ключ. Совпавшие по заголовку — выше.
 */
export function searchTasks(tasks: readonly TaskRecord[], query: string): SearchHit[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: Array<SearchHit & { score: number }> = [];
  for (const task of tasks) {
    const head = normalize(`${task.fm.title}\n${task.fm.summary}\n${task.slug}\n${task.fm.tracker ?? ''}`);
    const rest = normalize(`${task.body}\n${task.log ?? ''}`);
    if (!words.every((w) => head.includes(w) || rest.includes(w))) continue;
    const title = normalize(task.fm.title);
    const score = words.filter((w) => title.includes(w)).length * 2 + words.filter((w) => head.includes(w)).length;
    const missing = words.find((w) => !head.includes(w));
    let snippet: string | null = null;
    if (missing) {
      const line = `${task.body}\n${task.log ?? ''}`.split('\n').find((l) => normalize(l).includes(missing)) ?? '';
      snippet = line.trim().length > 140 ? `${line.trim().slice(0, 137)}…` : line.trim();
    }
    hits.push({ task, snippet, score });
  }
  const order = new Map(sortTasks(hits.map((h) => h.task)).map((t, i) => [t, i]));
  return hits
    .sort((a, b) => b.score - a.score || (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0))
    .map(({ task, snippet }) => ({ task, snippet }));
}
