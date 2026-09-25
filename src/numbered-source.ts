/**
 * ВРЕМЕННЫЙ ридер «нумерованной» школы задач (globex-site): только для
 * пилота 25.09.2026. Настоящий перенос всех трёх школ — конвертер story
 * `export-csv`; когда он появится, этот файл удаляется.
 *
 * Формат: `tasks/NNNN-slug.md` (активные) и `tasks/done/NNNN-slug.md`
 * (закрытые), общий `tasks/LOG.md`. Первая строка — `# NNNN — Название
 * (Фаза N)`, дальше строки `**Статус:** todo`, `**Зависит от:** …`.
 * Типа, приоритета и эпиков у задач нет: тип — story, приоритет пуст до
 * разбора в Kaiten.
 *
 * Ключ — `<repo>:<имя файла без .md>`, без папки: переезд файла в `done/`
 * не должен давать новую карточку.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FolderStatus, RepoSource, SourceScan, TaskFile, TaskHeader } from './task-source.js';

const FILE_RE = /^(\d{4})-([a-z0-9-]+)\.md$/;
const STATUS_LINE_RE = /^\*\*Статус:\*\*\s*(.+?)\s*$/m;

/** Статус строки файла → статус схемы. Папка `done/` сильнее строки. */
export function numberedStatus(raw: string | null, inDoneFolder: boolean): FolderStatus {
  if (inDoneFolder) return 'done';
  const s = (raw ?? '').toLowerCase().trim();
  if (s === 'done') return 'done';
  if (s === 'in progress' || s === 'in-progress') return 'in-progress';
  if (s === 'blocked') return 'blocked';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'backlog';
}

/** `# 0010 — Финал: данные, ассеты (Фаза 6)` → `Финал: данные, ассеты`. */
export function numberedTitle(firstLine: string, fallback: string): string {
  const title = firstLine
    .replace(/^#\s*/, '')
    .replace(/^\d{4}\s*[—–-]\s*/, '')
    .replace(/\s*\(Фаза[^)]*\)\s*$/i, '')
    .trim();
  return title || fallback;
}

export function parseNumberedTask(
  repo: RepoSource,
  fileName: string,
  text: string,
  inDoneFolder: boolean,
): TaskFile | null {
  const m = FILE_RE.exec(fileName);
  if (!m) return null;
  const slug = `${m[1]}-${m[2]}`;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines[0]?.startsWith('#') ? lines[0] : '';
  const statusRaw = STATUS_LINE_RE.exec(text)?.[1] ?? null;
  // Тело: без заголовка и без строки статуса — статусом владеет Kaiten.
  const body = (first ? lines.slice(1) : lines)
    .filter((l) => !STATUS_LINE_RE.test(l))
    .join('\n')
    .replace(/^\s+/, '');
  const dir = inDoneFolder ? 'tasks/done' : 'tasks';
  const status = numberedStatus(statusRaw, inDoneFolder);
  const title = numberedTitle(first, slug);
  const header: TaskHeader = {
    slug,
    title,
    type: null,
    priority: null,
    status: statusRaw,
    parent: null,
    created: null,
    related: [],
  };
  return {
    externalId: `${repo.name}:${slug}`,
    repoName: repo.name,
    repoUrl: repo.url,
    branch: repo.branch,
    dir,
    folderName: fileName,
    meta: { date: '', type: 'story', priority: null, slug },
    status,
    bucketMonth: null,
    title,
    header,
    body,
    parentExternalId: null,
    nested: false,
    hasLog: false,
    attachments: [],
    sourceFile: `${dir}/${fileName}`,
  };
}

export function collectNumberedTasks(repo: RepoSource): SourceScan {
  const root = join(repo.path, repo.tasksDirName ?? 'tasks');
  const tasks: TaskFile[] = [];
  const read = (folder: string, inDone: boolean): void => {
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder).sort()) {
      const task = FILE_RE.test(name) ? parseNumberedTask(repo, name, readFileSync(join(folder, name), 'utf8'), inDone) : null;
      if (task) tasks.push(task);
    }
  };
  read(root, false);
  read(join(root, 'done'), true);
  return { tasks, issues: [] };
}
