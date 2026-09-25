/**
 * Чтение задач репозитория как источника для заливки в Kaiten.
 *
 * Весь модуль — чистые функции без сети, кроме обхода файловой системы в
 * `collectTasks`. Так план заливки проверяется на реальном `tasks/` без токена
 * и без аккаунта.
 *
 * ПОЧЕМУ СТАТУС БЕРЁТСЯ ИЗ ПАПКИ. В шапке `TASK.md` есть поле `Status`, и оно
 * врёт: на 23.09.2026 у 75 задач там `todo` (такого статуса нет в правилах), у
 * `some-task` — `backlog` при папке `in-progress/`. `tasks/RULES.md`
 * прямо говорит «Статус = папка», поэтому папка выигрывает всегда, а
 * расхождение попадает в отчёт.
 *
 * ПОЧЕМУ КЛЮЧ — `YYYYMMDD_slug`. Он уходит в `external_id` карточки и должен
 * пережить всё, что с задачей происходит: переезд между папками (статус),
 * триаж (меняет и приоритет, и тип: `inbox/` → `backlog/<type>/`),
 * переименование родителя. Дата создания и slug — единственная пара, которая
 * не меняется. Проверено на 454 задачах: голый slug не уникален (`media-library`,
 * `checkout` — по два раза), `YYYYMMDD_slug` уникален.
 *
 * Статусы `ready` и `review` здесь не встречаются: по Q30 ими владеют Kaiten
 * (планирование) и git-события, у папок таких состояний нет.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';

import { PRIORITIES, TASK_TYPES, type Priority, type TaskType } from './core/schema.js';

export { PRIORITIES, TASK_TYPES, type Priority, type TaskType };

/** Статусы, выводимые из раскладки папок. */
export const FOLDER_STATUSES = ['inbox', 'backlog', 'in-progress', 'blocked', 'done', 'cancelled'] as const;
export type FolderStatus = (typeof FOLDER_STATUSES)[number];

export interface TaskHeader {
  slug: string | null;
  title: string | null;
  type: string | null;
  priority: string | null;
  status: string | null;
  parent: string | null;
  created: string | null;
  related: string[];
}

export interface FolderMeta {
  date: string;
  type: TaskType;
  /** `null` — приоритета нет (задачи globex); его ставят при разборе в Kaiten. */
  priority: Priority | null;
  slug: string;
}

export interface TaskFile {
  /**
   * Ключ идемпотентности, он же `external_id` карточки:
   * `acme-app:20260916_export-csv`. Имя репозитория в ключе
   * обязательно — воркер читает несколько репозиториев (Q17, Q22), а дата и
   * slug в разных репозиториях могут совпасть.
   */
  externalId: string;
  /** Репозиторий, из которого приехала задача. */
  repoName: string;
  /** База ссылок на этот репозиторий, например `https://github.com/acme-org/acme-app`. */
  repoUrl: string;
  /** Ветка, на которую ссылаются постоянные ссылки. */
  branch: string;
  /** Путь папки задачи от корня репозитория, в posix-виде. */
  dir: string;
  folderName: string;
  meta: FolderMeta;
  status: FolderStatus;
  /** `2026-09` для `done/` и `cancelled/`, иначе null. */
  bucketMonth: string | null;
  title: string;
  header: TaskHeader;
  body: string;
  /** `external_id` родителя: из `Parent:`, иначе из вложенности. */
  parentExternalId: string | null;
  /** Задача лежит внутри папки другой задачи. */
  nested: boolean;
  hasLog: boolean;
  /** Не-markdown файлы рядом (скриншоты, аудио) — в Kaiten не переносятся. */
  attachments: string[];
  /** Путь к файлу задачи, если задача — отдельный файл, а не папка (формат globex). */
  sourceFile?: string;
  /** «Суть» для людей (формат v2); пока приходит из оверлея пилота. */
  summary?: string;
  /** Команда, если она не «по умолчанию»; пока приходит из оверлея пилота. */
  team?: string;
}

export interface SourceIssue {
  dir: string;
  problem: 'no-task-md' | 'bad-folder-name' | 'status-mismatch';
  detail: string;
}

export interface SourceScan {
  tasks: TaskFile[];
  issues: SourceIssue[];
}

const FOLDER_RE = /^(\d{8})_([a-z]+)_(p[0-3n])_(.+)$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function parseFolderName(name: string): FolderMeta | null {
  const m = FOLDER_RE.exec(name);
  if (!m) return null;
  const [, date, type, priority, slug] = m;
  if (!(TASK_TYPES as readonly string[]).includes(type)) return null;
  if (!(PRIORITIES as readonly string[]).includes(priority)) return null;
  return { date, type: type as TaskType, priority: priority as Priority, slug };
}

/**
 * `20260916_spike_p1_tracker-pilot-kaiten` →
 * `acme-app:20260916_tracker-pilot-kaiten`.
 */
export function externalIdFromFolder(name: string, repoName: string): string | null {
  const meta = parseFolderName(name);
  return meta ? `${repoName}:${meta.date}_${meta.slug}` : null;
}

/**
 * Статус по раскладке. Путь — от корня репозитория, разделители любые.
 * Вложенные подзадачи наследуют бакет верхнего уровня: story внутри папки эпика
 * в `done/2026-05/` — тоже `done`.
 */
export function statusFromPath(relDir: string): { status: FolderStatus; bucketMonth: string | null } | null {
  const parts = relDir.split(/[\\/]+/).filter(Boolean);
  if (parts[0] !== 'tasks') return null;
  const bucket = parts[1];
  if (bucket === 'in-progress') return { status: 'in-progress', bucketMonth: null };
  if (bucket === 'blocked') return { status: 'blocked', bucketMonth: null };
  if (bucket === 'done' || bucket === 'cancelled') {
    const month = parts[2] && MONTH_RE.test(parts[2]) ? parts[2] : null;
    return { status: bucket, bucketMonth: month };
  }
  if (bucket === 'backlog') {
    return { status: parts[2] === 'inbox' ? 'inbox' : 'backlog', bucketMonth: null };
  }
  return null;
}

/**
 * Шапка `TASK.md` — не YAML, а plain `Key: value` до строки-разделителя `---`.
 * Файлы в репозитории с CRLF, поэтому разделитель ищется по строке без `\r`.
 */
export function parseTaskFile(text: string): { header: TaskHeader; body: string } {
  const lines = text.split(/\r?\n/);
  const sep = lines.findIndex((l) => l.trimEnd() === '---');
  const headLines = sep === -1 ? [] : lines.slice(0, sep);
  const body = sep === -1 ? text : lines.slice(sep + 1).join('\n').replace(/^\n+/, '');

  const header: TaskHeader = {
    slug: null,
    title: null,
    type: null,
    priority: null,
    status: null,
    parent: null,
    created: null,
    related: [],
  };

  let inRelated = false;
  for (const raw of headLines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (inRelated && item) {
      header.related.push(item[1].trim());
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    inRelated = key === 'related';
    switch (key) {
      case 'slug':
        header.slug = value || null;
        break;
      case 'title':
        header.title = value || null;
        break;
      case 'type':
        header.type = value || null;
        break;
      case 'priority':
        header.priority = value || null;
        break;
      case 'status':
        header.status = value || null;
        break;
      case 'created':
        header.created = value || null;
        break;
      case 'parent':
        header.parent = value && value !== '—' ? value : null;
        break;
      default:
        break;
    }
  }
  return { header, body };
}

/**
 * `Parent:` разрешается по имени папки, а не по пути: пути в шапках протухают
 * при переезде задачи между статусами (прецедент — `ai-core`, где `## Stories`
 * ссылается на `backlog/stories/...`, а задача давно в `done/2026-04/`).
 */
export function parentExternalIdFromHeader(parent: string | null, repoName: string): string | null {
  if (!parent) return null;
  const clean = parent.replace(/[\\/]+$/, '').trim();
  if (!clean) return null;
  return externalIdFromFolder(basename(clean), repoName);
}

function listDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

export interface RepoSource {
  /** Имя репозитория — уезжает в `external_id` и в поле карточки. */
  name: string;
  /** Абсолютный или относительный путь к рабочей копии. */
  path: string;
  /** База постоянных ссылок; если пусто — ссылки не переписываются. */
  url: string;
  branch: string;
  tasksDirName?: string;
  /** Раскладка задач: папки-статусы (по умолчанию) или нумерованные файлы globex. */
  layout?: 'folders' | 'numbered';
}

/** Обход `tasks/`: каждая папка с `TASK.md` — задача, включая вложенные в эпик. */
export function collectTasks(repo: RepoSource): SourceScan {
  const repoRoot = repo.path;
  const tasksDirName = repo.tasksDirName ?? 'tasks';
  const tasks: TaskFile[] = [];
  const issues: SourceIssue[] = [];

  const walk = (dir: string, parentExternalId: string | null): void => {
    for (const name of listDirs(dir)) {
      const full = join(dir, name);
      const relDir = relative(repoRoot, full).split(sep).join(posix.sep);
      const files = listFiles(full);
      const hasTask = files.includes('TASK.md');
      const meta = parseFolderName(name);

      if (!hasTask) {
        // Не всякая папка — задача: `backlog/`, `done/2026-05/` — это бакеты.
        if (meta) {
          issues.push({
            dir: relDir,
            problem: 'no-task-md',
            detail: `папка названа как задача, но TASK.md нет (есть: ${files.join(', ') || 'ничего'})`,
          });
        }
        walk(full, parentExternalId);
        continue;
      }

      if (!meta) {
        issues.push({ dir: relDir, problem: 'bad-folder-name', detail: 'имя не по шаблону YYYYMMDD_type_pX_slug' });
        walk(full, parentExternalId);
        continue;
      }

      const placement = statusFromPath(relDir);
      if (!placement) {
        issues.push({ dir: relDir, problem: 'bad-folder-name', detail: 'папка вне известных бакетов tasks/' });
        walk(full, parentExternalId);
        continue;
      }

      const externalId = `${repo.name}:${meta.date}_${meta.slug}`;
      const raw = readFileSync(join(full, 'TASK.md'), 'utf8');
      const { header, body } = parseTaskFile(raw);
      const headerParent = parentExternalIdFromHeader(header.parent, repo.name);

      if (header.status && header.status.split(/[\s(]/)[0] !== placement.status) {
        issues.push({
          dir: relDir,
          problem: 'status-mismatch',
          detail: `в шапке «${header.status}», по папке «${placement.status}» — побеждает папка`,
        });
      }

      tasks.push({
        externalId,
        repoName: repo.name,
        repoUrl: repo.url,
        branch: repo.branch,
        dir: relDir,
        folderName: name,
        meta,
        status: placement.status,
        bucketMonth: placement.bucketMonth,
        title: header.title ?? meta.slug,
        header,
        body,
        parentExternalId: headerParent ?? parentExternalId,
        nested: parentExternalId !== null,
        hasLog: files.includes('LOG.md'),
        attachments: files.filter((f) => !f.endsWith('.md')),
      });

      walk(full, externalId);
    }
  };

  walk(join(repoRoot, tasksDirName), null);
  return { tasks, issues };
}

/**
 * `git remote get-url origin` → база для ссылок на GitHub.
 * Угадывать владельца репозитория нельзя: ссылка уезжает в каждую карточку, а
 * имя автора коммитов и владелец репозитория — разные вещи.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@]+@)?(.+?)(?:\.git)?$/.exec(value);
  if (https) return `https://${https[1]}`;
  return null;
}

export type ScopeName = 'pilot' | 'active' | 'active+done' | 'all';

export interface ScopeOptions {
  scope: ScopeName;
  /** Для `pilot`: slug'и или external_id эпиков; берутся они и всё их дерево. */
  epics?: string[];
  /** Точечный отбор по external_id, сильнее любого scope. */
  only?: string[];
  /** Для `active+done`: нижняя граница бакета `done/`, например `2026-07`. */
  doneSince?: string | null;
}

const ACTIVE: readonly FolderStatus[] = ['inbox', 'backlog', 'in-progress', 'blocked'];

/** Отбор задач под заливку. Дети эпика подтягиваются рекурсивно. */
export function selectScope(tasks: TaskFile[], options: ScopeOptions): TaskFile[] {
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only);
    return tasks.filter((t) => wanted.has(t.externalId));
  }

  if (options.scope === 'pilot') {
    const picked = new Set<string>();
    for (const key of options.epics ?? []) {
      for (const t of tasks) {
        if (t.meta.slug === key || t.externalId === key) picked.add(t.externalId);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tasks) {
        if (picked.has(t.externalId)) continue;
        if (t.parentExternalId && picked.has(t.parentExternalId)) {
          picked.add(t.externalId);
          grew = true;
        }
      }
    }
    return tasks.filter((t) => picked.has(t.externalId));
  }

  if (options.scope === 'all') return [...tasks];

  const active = tasks.filter((t) => ACTIVE.includes(t.status));
  if (options.scope === 'active') return active;

  const since = options.doneSince ?? null;
  const done = tasks.filter(
    (t) => t.status === 'done' && (!since || (t.bucketMonth !== null && t.bucketMonth >= since)),
  );
  return [...active, ...done];
}

/**
 * Относительные markdown-ссылки в теле задачи → постоянные URL GitHub.
 * В карточке относительный путь не кликается, а в вики ссылаются 405 файлов
 * задач. Репозиторий приватный: ссылка работает только у того, у кого есть
 * доступ к GitHub, — гостю-клиенту (Q12) она бесполезна.
 */
export function rewriteRelativeLinks(
  body: string,
  opts: { taskDir: string; repoUrl: string; branch: string },
): string {
  const { taskDir, repoUrl, branch } = opts;
  const base = repoUrl.replace(/\/+$/, '');
  return body.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match: string, target: string, title?: string) => {
    if (/^(https?:|mailto:|#|\/\/)/i.test(target)) return match;
    const [pathPart, anchor] = target.split('#');
    if (!pathPart) return match;
    const resolved = posix.normalize(posix.join(taskDir, pathPart));
    if (resolved.startsWith('..')) return match;
    return `](${base}/blob/${branch}/${resolved}${anchor ? `#${anchor}` : ''}${title ?? ''})`;
  });
}
