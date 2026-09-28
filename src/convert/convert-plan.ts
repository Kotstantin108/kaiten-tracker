/**
 * Конвертер старых школ задач в формат v2 — чистая часть: задачи старых
 * раскладок + история git + оверлей + карточки Kaiten на входе, файлы
 * репозитория задач проекта и отчёт на выходе. Ни диска, ни сети.
 *
 * ПРАВИЛА (story `export-csv`, решения 23–25.09.2026):
 *   · `id` выводится, а не генерируется: ULID из даты создания и sha256
 *     `external_id`. Повторный прогон даёт те же id без хранимого состояния,
 *     и родителя можно назвать его id ещё до выгрузки в Kaiten.
 *   · `tracker` — id уже существующей карточки (пилот). Без него первая же
 *     команда записи сочла бы задачу новой и завела дубль.
 *   · Статус — по папке, а не по шапке; расхождения уходят в отчёт.
 *   · Тело — как было, меняются только ссылки: на код — в постоянные URL
 *     GitHub, на другие задачи — в пути репозитория задач, на вложения — в
 *     `/attachments/<slug>/`. Заголовки разделов не переименовываются: по
 *     ним сопоставлены чек-листы «Агент · …» живых карточек пилота.
 *   · «Суть» — из оверлея; иначе механический черновик, помеченный в отчёте
 *     «проверить».
 *   · «Кем и когда закрыто» — первая строка `<slug>.log.md`: в строгой
 *     схеме такого поля нет, а журнал — место истории.
 *   · Каждая исходная папка либо конвертирована, либо названа в отчёте с
 *     причиной — молча не теряется ничего.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { contentHash, serializeTaskDocument } from '../core/document.js';
import { SLUG_RE } from '../core/lint.js';
import { CLOSED_STATUSES, FrontmatterSchema, type Frontmatter, type Priority, type TaskStatus, type TaskType } from '../core/schema.js';
import { ulid } from '../core/ulid.js';
import type { TaskFile } from '../task-source.js';
import type { TaskHistory } from './git-history.js';

export interface OverlayEntry {
  summary?: string;
  team?: string;
  /** `false` — черновик «Сути», ещё не проверен человеком или агентом. */
  reviewed?: boolean;
}

/** Карточка Kaiten задачи: поля, которыми владеет Kaiten (решения 5 и 9). */
export interface CardFields {
  id: number;
  status?: TaskStatus;
  type?: TaskType;
  priority?: Priority;
  team?: string;
}

export interface ConvertInput {
  tasks: readonly TaskFile[];
  /** История по `external_id`. */
  history: ReadonlyMap<string, TaskHistory>;
  /** Содержимое `LOG.md` по `external_id`. */
  logs: ReadonlyMap<string, string>;
  overlay: Readonly<Record<string, OverlayEntry>>;
  /**
   * Карточки Kaiten по `external_id`: id и статус по колонке. Статусом
   * владеет Kaiten, поэтому у задачи с карточкой он сильнее папки.
   */
  cards: ReadonlyMap<string, CardFields>;
  /**
   * Есть ли файл в репозитории кода (путь от корня). Нужен, чтобы выбрать
   * верную базу относительной ссылки: задачи переезжали между папками разной
   * глубины, а ссылки в них писались от прежнего места.
   */
  exists?: (repoName: string, path: string) => boolean;
  /**
   * Всё, что лежит в папке задачи кроме `TASK.md`, `LOG.md` и вложенных задач
   * (исследования, handoff, скрипты, `assets/`), — пути от папки задачи.
   * Без этого списка берутся только `task.attachments` (файлы не-.md верхнего
   * уровня), и остальное при переносе потерялось бы.
   */
  extraFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * Человек по автору коммита: почта → ключ (`convert/people.json`). Нет в
   * таблице — остаётся имя автора из git, и оно попадает в отчёт.
   */
  person?: (commit: { author: string; email: string }) => string | undefined;
}

export interface OutputFile {
  path: string;
  text: string;
}

export interface AttachmentCopy {
  repoName: string;
  /** Путь в репозитории кода. */
  from: string;
  /** Путь в репозитории задач. */
  to: string;
}

export interface ConvertedTask {
  externalId: string;
  slug: string;
  path: string;
  frontmatter: Frontmatter;
}

export interface ConvertReport {
  converted: number;
  byStatus: Record<string, number>;
  statusMismatch: Array<{ externalId: string; header: string; folder: TaskStatus }>;
  /** Карточка в Kaiten стоит не там, где папка: взят статус Kaiten. */
  kaitenStatus: Array<{ externalId: string; folder: TaskStatus; kaiten: TaskStatus }>;
  /** Поля карточки, отличные от файла (тип, приоритет, команда): взяты из Kaiten. */
  kaitenFields: Array<{ externalId: string; field: string; file: string; kaiten: string }>;
  slugRenames: Array<{ externalId: string; from: string; to: string }>;
  summaryDrafts: string[];
  trackers: number;
  parentProblems: Array<{ externalId: string; problem: string }>;
  unresolvedLinks: Array<{ externalId: string; target: string }>;
  noHistory: string[];
  authors: Record<string, number>;
  /** Авторы git, которых нет в таблице людей: `имя <почта>` → число задач. */
  unknownAuthors: Record<string, number>;
  attachments: number;
}

export interface ConvertResult {
  /** Новые механические черновики «Сути» по `external_id` — для файла черновиков. */
  drafts: Record<string, string>;
  files: OutputFile[];
  attachments: AttachmentCopy[];
  tasks: ConvertedTask[];
  report: ConvertReport;
}

export const SUMMARY_LIMIT = 300;

/** ULID из даты создания и хеша ключа: одинаковый при каждом прогоне. */
export function deriveId(externalId: string, created: string): string {
  const [y, m, d] = created.split('-').map(Number);
  const random = createHash('sha256').update(externalId).digest().subarray(0, 10);
  return ulid(Date.UTC(y, m - 1, d), random);
}

function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function normalizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return SLUG_RE.test(slug) ? slug : 'task';
}

function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MOTIVE_HEADING_RE = /^#{1,6}\s+(?:Мотивация|Зачем|Цель|Проблема|Контекст|Вопрос|Что происходит)/i;

/**
 * Механический черновик «Сути»: первый абзац раздела «Мотивация/Зачем/Цель»,
 * иначе первый абзац тела, без разметки, до трёх предложений и 300 знаков.
 * Это заготовка на проверку человеком или агентом, а не готовый текст.
 */
export function draftSummary(body: string, title: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => MOTIVE_HEADING_RE.test(l));
  const from = start >= 0 ? start + 1 : 0;
  const paragraph: string[] = [];
  let inFence = false;
  for (const line of lines.slice(from)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (!trimmed || /^[|-]{3}|^\|/.test(trimmed) || /^\*\*[^*]+:\*\*/.test(trimmed)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, ''));
  }
  const text = stripMarkdown(paragraph.join(' ')) || title;
  const sentences = text.match(/[^.!?…]+[.!?…]+(?=\s|$)|[^.!?…]+$/g) ?? [text];
  let out = '';
  for (const sentence of sentences.slice(0, 3)) {
    const next = `${out} ${sentence.trim()}`.trim();
    if (next.length > SUMMARY_LIMIT) break;
    out = next;
  }
  if (!out) {
    const cut = text.slice(0, SUMMARY_LIMIT - 1);
    out = `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length)}…`;
  }
  return out;
}

const PHASE_RE = /^\*\*Фаза:\*\*\s*(.+?)\s*$/m;
const DEPENDS_RE = /^\*\*Зависит от:\*\*\s*(.+?)\s*$/m;
const TASK_FOLDER_SEGMENT_RE = /^(\d{8})_[a-z]+_[^_/]+_(.+)$/;
const NUMBERED_FILE_RE = /^(\d{4}-[a-z0-9-]+)\.md$/;

interface Planned {
  task: TaskFile;
  slug: string;
  id: string;
  status: TaskStatus;
  path: string;
  logPath: string;
}

/** Задача по пути в репозитории кода: `tasks/…/<папка-задачи>/<остаток>` или файл globex. */
function locate(repoName: string, resolved: string, byExternalId: ReadonlyMap<string, Planned>): { target: Planned; rest: string } | null {
  const parts = resolved.split('/');
  if (parts[0] !== 'tasks') return null;
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const folder = TASK_FOLDER_SEGMENT_RE.exec(parts[i]);
    if (folder) {
      // Дата в ссылке бывает не та (задачу завели позже, чем написали
      // ссылку): тогда ищем по slug, если он в репозитории один.
      const exact = byExternalId.get(`${repoName}:${folder[1]}_${folder[2]}`);
      const bySlug = [...byExternalId.values()].filter((x) => x.task.repoName === repoName && x.task.meta.slug === folder[2]);
      const target = exact ?? (bySlug.length === 1 ? bySlug[0] : undefined);
      if (target) return { target, rest: parts.slice(i + 1).join('/') };
    }
    const numbered = NUMBERED_FILE_RE.exec(parts[i]);
    if (numbered && i === parts.length - 1) {
      const target = byExternalId.get(`${repoName}:${numbered[1]}`);
      if (target) return { target, rest: '' };
    }
  }
  return null;
}

/** Базы относительных ссылок задачи: текущая папка, затем та же задача на глубине 2 и 3 под `tasks/`. */
function linkBases(task: TaskFile): string[] {
  if (task.sourceFile) return ['tasks', 'tasks/done'];
  const parts = task.dir.split('/');
  const first = parts.findIndex((seg, i) => i > 0 && TASK_FOLDER_SEGMENT_RE.test(seg));
  const tail = first > 0 ? parts.slice(first).join('/') : parts.at(-1) ?? '';
  return [...new Set([task.dir, `tasks/_/${tail}`, `tasks/_/_/${tail}`])];
}

function month(date: string): string {
  return date.slice(0, 7);
}

export function convertProject(input: ConvertInput): ConvertResult {
  const report: ConvertReport = {
    converted: 0,
    byStatus: {},
    statusMismatch: [],
    kaitenStatus: [],
    kaitenFields: [],
    slugRenames: [],
    summaryDrafts: [],
    trackers: 0,
    parentProblems: [],
    unresolvedLinks: [],
    noHistory: [],
    authors: {},
    unknownAuthors: {},
    attachments: 0,
  };

  // Порядок входа не должен влиять на результат.
  const tasks = [...input.tasks].sort((a, b) => a.externalId.localeCompare(b.externalId));

  // 1. slug: уникален во всём репозитории задач проекта, конфликт решается
  //    детерминированно — первый по external_id сохраняет slug, остальные
  //    получают суффикс даты, затем имени репозитория.
  const base = new Map<string, string>();
  for (const task of tasks) base.set(task.externalId, normalizeSlug(task.meta.slug));
  const slugOf = new Map<string, string>();
  const taken = new Set<string>();
  const groups = new Map<string, TaskFile[]>();
  for (const task of tasks) {
    const b = base.get(task.externalId) as string;
    groups.set(b, [...(groups.get(b) ?? []), task]);
  }
  for (const [b, group] of groups) {
    group.forEach((task, index) => {
      let slug = b;
      if (index > 0 || taken.has(slug)) {
        const candidates = [task.meta.date ? `${b}-${task.meta.date}` : null, `${b}-${normalizeSlug(task.repoName)}`];
        slug = candidates.find((c): c is string => c !== null && !taken.has(c)) ?? `${b}-${index + 1}`;
      }
      if (slug !== task.meta.slug) {
        report.slugRenames.push({ externalId: task.externalId, from: task.meta.slug, to: slug });
      }
      taken.add(slug);
      slugOf.set(task.externalId, slug);
    });
  }

  // 2. id, статус, путь.
  const planned = new Map<string, Planned>();
  for (const task of tasks) {
    const history = input.history.get(task.externalId);
    const created = task.meta.date ? isoDate(task.meta.date) : (history?.first.date ?? '2026-01-01');
    const slug = slugOf.get(task.externalId) as string;
    const kaiten = input.cards.get(task.externalId)?.status;
    const status: TaskStatus = kaiten ?? task.status;
    if (kaiten && kaiten !== task.status) report.kaitenStatus.push({ externalId: task.externalId, folder: task.status, kaiten });
    let dir = 'active';
    if (CLOSED_STATUSES.includes(status)) {
      const archiveMonth = task.bucketMonth ?? (history?.closed ? month(history.closed.date) : null) ?? (history ? month(history.last.date) : month(created));
      dir = `archive/${archiveMonth}`;
    }
    planned.set(task.externalId, {
      task,
      slug,
      id: deriveId(task.externalId, created),
      status,
      path: `${dir}/${slug}.md`,
      logPath: `${dir}/${slug}.log.md`,
    });
  }

  const who = (commit: { author: string; email: string }): string => {
    const key = input.person?.(commit);
    if (key) return key;
    const raw = `${commit.author} <${commit.email}>`;
    report.unknownAuthors[raw] = (report.unknownAuthors[raw] ?? 0) + 1;
    return commit.author;
  };
  const extrasOf = (task: TaskFile): readonly string[] => input.extraFiles?.get(task.externalId) ?? task.attachments;
  /** Путь внутри папки задачи — её вложение: файл или подпапка с файлами. */
  const holds = (task: TaskFile, rel: string): boolean => {
    const clean = rel.replace(/\/$/, '');
    return extrasOf(task).some((f) => f === clean || f.startsWith(`${clean}/`));
  };
  const files: OutputFile[] = [];
  const drafts: Record<string, string> = {};
  const attachments: AttachmentCopy[] = [];
  const converted: ConvertedTask[] = [];

  for (const p of planned.values()) {
    const { task } = p;
    const history = input.history.get(task.externalId);
    if (!history) report.noHistory.push(task.externalId);
    const created = task.meta.date ? isoDate(task.meta.date) : (history?.first.date ?? '2026-01-01');

    if (task.header.status) {
      const headerStatus = task.header.status.split(/[\s(]/)[0];
      if (headerStatus !== p.status && task.meta.date) {
        report.statusMismatch.push({ externalId: task.externalId, header: task.header.status, folder: p.status });
      }
    }

    // Ссылки тела. База — место, где задачу писали: пробуем текущую папку и
    // ту же задачу на другой глубине (`in-progress/X` ↔ `backlog/stories/X`,
    // `tasks/` ↔ `tasks/done/` у globex) и берём первую, где цель существует.
    const bases = linkBases(task);
    const exists = input.exists ?? (() => false);
    const body = task.body.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match: string, target: string, title?: string) => {
      if (/^(https?:|mailto:|#|\/)/i.test(target)) return match;
      const [pathPart, anchor] = target.split('#');
      if (!pathPart) return match;
      const suffix = `${anchor ? `#${anchor}` : ''}${title ?? ''}`;
      const candidates = bases.map((b) => posix.normalize(posix.join(b, pathPart))).filter((r) => !r.startsWith('..'));
      for (const resolved of candidates) {
        // Своя папка тоже находится здесь: ссылка на `RESEARCH.md` рядом с TASK.md.
        const hit = locate(task.repoName, resolved, planned);
        if (hit) {
          if (hit.rest === '' || hit.rest === 'TASK.md') return `](/${hit.target.path}${suffix})`;
          if (hit.rest === 'LOG.md') return `](/${hit.target.logPath}${suffix})`;
          if (holds(hit.target.task, hit.rest)) return `](/attachments/${hit.target.slug}/${hit.rest}${suffix})`;
        }
        if (!resolved.startsWith('tasks/') && exists(task.repoName, resolved.replace(/\/$/, ''))) {
          return task.repoUrl ? `](${task.repoUrl}/blob/${task.branch}/${resolved}${suffix})` : match;
        }
      }
      report.unresolvedLinks.push({ externalId: task.externalId, target });
      // Файла нет (удалён или ссылка была битой и раньше): ссылка на код всё
      // равно уходит постоянной ссылкой — в истории GitHub его видно.
      const first = candidates[0];
      if (first && !first.startsWith('tasks/') && task.repoUrl) return `](${task.repoUrl}/blob/${task.branch}/${first}${suffix})`;
      return match;
    });

    for (const file of extrasOf(task)) {
      attachments.push({ repoName: task.repoName, from: `${task.dir}/${file}`, to: `attachments/${p.slug}/${file}` });
      report.attachments += 1;
    }

    // related: задачи — slug, остальное — постоянная ссылка на код.
    const related: string[] = [];
    for (const entry of task.header.related) {
      const token = entry.split(/\s/)[0];
      const hit = locate(task.repoName, posix.normalize(token.replace(/^\.\//, '')), planned);
      if (hit) related.push(hit.target.slug);
      else if (task.repoUrl && /[/.]/.test(token) && !/^https?:/.test(token)) related.push(`${task.repoUrl}/blob/${task.branch}/${token.replace(/^\.\//, '')}${entry.slice(token.length)}`);
      else related.push(entry);
    }
    const depends = DEPENDS_RE.exec(task.body)?.[1];
    if (depends) {
      for (const num of depends.match(/\b\d{4}\b/g) ?? []) {
        const target = [...planned.values()].find((x) => x.task.repoName === task.repoName && x.task.meta.slug.startsWith(`${num}-`));
        if (target) related.push(target.slug);
      }
    }

    // Родитель: только эпик, и только у не-эпика (уровней два).
    let epic: string | undefined;
    if (task.parentExternalId) {
      const parent = planned.get(task.parentExternalId);
      if (!parent) report.parentProblems.push({ externalId: task.externalId, problem: `родитель ${task.parentExternalId} не найден` });
      else if (task.meta.type === 'epic') report.parentProblems.push({ externalId: task.externalId, problem: `эпик внутри эпика ${parent.slug} — связь не перенесена` });
      else if (parent.task.meta.type !== 'epic') report.parentProblems.push({ externalId: task.externalId, problem: `родитель ${parent.slug} — ${parent.task.meta.type}, не эпик — связь не перенесена` });
      else epic = parent.id;
    }

    const overlay = input.overlay[task.externalId];
    // «Суть»: проверенная из оверлея; непроверенный черновик оттуда же; иначе
    // новый механический черновик. Непроверенное — в отчёт на проверку.
    let summary = overlay?.summary;
    if (!summary) {
      summary = draftSummary(task.body, task.title);
      drafts[task.externalId] = summary;
    }
    if (!overlay?.summary || overlay.reviewed === false) report.summaryDrafts.push(task.externalId);

    const card = input.cards.get(task.externalId);
    const cardId = card?.id;
    if (cardId !== undefined) report.trackers += 1;
    const type = card?.type ?? task.meta.type;
    const priority = card?.priority ?? task.meta.priority ?? undefined;
    const team = card?.team ?? overlay?.team;
    for (const [field, file, kaiten] of [['type', task.meta.type, card?.type], ['priority', task.meta.priority, card?.priority], ['team', overlay?.team, card?.team]] as const) {
      if (kaiten !== undefined && kaiten !== file) report.kaitenFields.push({ externalId: task.externalId, field, file: file ?? '—', kaiten });
    }

    const author = history ? who(history.first) : 'неизвестно';
    report.authors[author] = (report.authors[author] ?? 0) + 1;
    const phase = PHASE_RE.exec(task.body)?.[1];

    const fm: Frontmatter = FrontmatterSchema.parse({
      id: p.id,
      tracker: cardId !== undefined ? String(cardId) : undefined,
      title: task.title,
      summary,
      type,
      status: p.status,
      repo: task.repoName,
      epic,
      related: related.length > 0 ? [...new Set(related)] : undefined,
      priority,
      team,
      created,
      created_by: author,
      updated: history?.last.date ?? created,
      planning: phase ? { phase } : undefined,
    });
    const docBody = `\n${body.replace(/^\n+/, '').replace(/\s*$/, '\n')}`;
    fm.content_hash = contentHash(fm, docBody);
    files.push({ path: p.path, text: serializeTaskDocument(fm, docBody) });

    const log = input.logs.get(task.externalId);
    const closedLine =
      CLOSED_STATUSES.includes(task.status) && p.status === task.status && history
        ? `- ${(history.closed ?? history.last).date} — ${p.status === 'done' ? 'закрыто' : 'отменено'}: ${who(history.closed ?? history.last)} (по истории git при переносе в формат v2)\n`
        : '';
    if (log || closedLine) {
      files.push({ path: p.logPath, text: `${closedLine}${closedLine && log ? '\n' : ''}${log ? log.replace(/\r\n/g, '\n').replace(/\s*$/, '\n') : ''}` });
    }

    converted.push({ externalId: task.externalId, slug: p.slug, path: p.path, frontmatter: fm });
    report.converted += 1;
    report.byStatus[p.status] = (report.byStatus[p.status] ?? 0) + 1;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { drafts, files, attachments, tasks: converted, report };
}
