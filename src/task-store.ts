/**
 * Хранилище задач проекта на машине разработчика: git без рабочей копии
 * (`clone --bare`). Решение владельца 28.09.2026: единственный путь к задачам
 * — CLI `kaiten`; файлов задач, которые можно открыть или поправить руками,
 * на диске нет. Люди читают задачи на GitHub или в копии `kaiten export`.
 *
 * Где лежит: `%LOCALAPPDATA%\kaiten\<tasksRepo>.git` (macOS — `~/Library/
 * Application Support/kaiten`, Linux — `$XDG_DATA_HOME/kaiten`). `KAITEN_STORE`
 * подменяет путь целиком — для тестов и пробных прогонов. Путь не печатается
 * никогда: ни в выводе, ни в ошибках (сырые ошибки git его содержат, поэтому
 * они переводятся в `StoreError` с видом ошибки).
 *
 * Чтение: `ls-tree -r -z` + один `cat-file --batch` на все файлы — замер
 * 28.09 на 908 файлах Acme: ~0,2 с, не медленнее чтения папки.
 * Обновление: `fetch` + перемотка ветки только вперёд; локальных коммитов у
 * команд чтения не бывает, расхождение — ошибка (понадобится командам записи).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { TasksTree } from './tasks-files.js';

export type StoreErrorKind = 'no-access' | 'offline' | 'not-found' | 'diverged' | 'not-store' | 'other';

export class StoreError extends Error {
  constructor(readonly kind: StoreErrorKind) {
    super(kind);
  }
}

export function defaultStorePath(name: string): string {
  if (process.env.KAITEN_STORE) return resolve(process.env.KAITEN_STORE);
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(base, 'kaiten', `${name}.git`);
}

/** Вид ошибки по тексту git — сам текст наружу не выходит: в нём пути. */
function classify(stderr: string): StoreErrorKind {
  if (/Authentication failed|Permission denied|could not read Username|returned error: 403|access denied/i.test(stderr)) return 'no-access';
  if (/Repository not found|does not appear to be a git repository|not found/i.test(stderr)) return 'not-found';
  if (/Could not resolve host|unable to access|timed out|Failed to connect|Connection refused|network/i.test(stderr)) return 'offline';
  return 'other';
}

const GIT_BASE = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false'];

function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
  try {
    return execFileSync('git', [...GIT_BASE, ...args], { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    throw new StoreError(classify(stderr));
  }
}

function gitText(cwd: string, args: string[]): string {
  return git(cwd, args).toString('utf8').trim();
}

export function isStore(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return gitText(dir, ['rev-parse', '--is-bare-repository']) === 'true';
  } catch {
    return false;
  }
}

export function cloneStore(url: string, dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    git(dirname(dir), ['clone', '--quiet', '--bare', url, dir]);
    // `clone --bare` не заводит refspec: без него `fetch` не обновит origin/*.
    git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(dir, ['fetch', '--quiet', 'origin']);
  } catch (error) {
    // Полухранилище не оставляем: удалить его человеку нечем — путь не называется.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Забрать свежее и перемотать ветку вперёд. `true` — что-то изменилось. */
export function updateStore(dir: string): boolean {
  if (!isStore(dir)) throw new StoreError('not-store');
  git(dir, ['fetch', '--quiet', '--prune', 'origin']);
  const branch = gitText(dir, ['symbolic-ref', '--short', 'HEAD']);
  const remote = `refs/remotes/origin/${branch}`;
  let theirs: string;
  try {
    theirs = gitText(dir, ['rev-parse', '--verify', '--quiet', remote]);
  } catch {
    return false; // В репозитории задач ещё нет ни одного коммита.
  }
  let ours: string | null = null;
  try {
    ours = gitText(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    ours = null;
  }
  if (ours === theirs) return false;
  if (ours !== null) {
    try {
      git(dir, ['merge-base', '--is-ancestor', ours, theirs]);
    } catch {
      throw new StoreError('diverged');
    }
  }
  git(dir, ['update-ref', `refs/heads/${branch}`, theirs]);
  return true;
}

export interface StoreEntry {
  path: string;
  sha: string;
  size: number;
}

/** Все файлы последнего состояния задач. Пустой репозиторий — пустой список. */
export function listEntries(dir: string): StoreEntry[] {
  let out: Buffer;
  try {
    out = git(dir, ['ls-tree', '-r', '-z', '--long', 'HEAD']);
  } catch {
    return [];
  }
  const entries: StoreEntry[] = [];
  for (const record of out.toString('utf8').split('\0')) {
    // `<mode> blob <sha> <size>\t<path>`
    const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/s.exec(record);
    if (m) entries.push({ sha: m[1], size: Number(m[2]), path: m[3] });
  }
  return entries;
}

/** Содержимое файлов одним `cat-file --batch`; разбор по размеру в байтах, не по строкам. */
export function readBlobs(dir: string, shas: readonly string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;
  const out = git(dir, ['cat-file', '--batch'], `${unique.join('\n')}\n`);
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    if (eol === -1) break;
    const header = out.subarray(pos, eol).toString('utf8').split(' ');
    pos = eol + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    result.set(header[0], out.subarray(pos, pos + size));
    pos += size + 1;
  }
  return result;
}

/** Задачи и журналы в той же форме, что и чтение папки (`tasks-files.ts`). */
export function readStoreTree(dir: string, entries: readonly StoreEntry[]): TasksTree {
  const wanted = entries.filter((e) => /^(?:active|archive)\/.+\.md$/.test(e.path)).sort((a, b) => a.path.localeCompare(b.path));
  const blobs = readBlobs(
    dir,
    wanted.map((e) => e.sha),
  );
  const tree: TasksTree = { files: [], logs: new Map() };
  for (const e of wanted) {
    const text = blobs.get(e.sha)?.toString('utf8') ?? '';
    if (e.path.endsWith('.log.md')) tree.logs.set(e.path.replace(/\.log\.md$/, '.md'), text);
    else tree.files.push({ path: e.path, text });
  }
  return tree;
}

/** sha1 git-объекта blob — чтобы узнать, правили ли файл копии. */
export function blobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

// ── копия для чтения людьми ─────────────────────────────────────────────

export const EXPORT_MANIFEST = '.kaiten-export.json';

export type ExportRefusal = 'foreign-folder' | 'inside-repo' | 'other-project';

export interface ExportResult {
  refused?: ExportRefusal;
  written: number;
  removed: number;
  /** Файлы копии, изменённые вручную: без `force` не перезаписываются. */
  modified: string[];
}

interface Manifest {
  project: string;
  files: Record<string, string>;
}

function readManifest(target: string): Manifest | null {
  const path = join(target, EXPORT_MANIFEST);
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('project' in raw) || !('files' in raw)) return null;
  return raw as Manifest;
}

/** Ближайшая существующая папка вверх — лежит ли она в рабочей копии git (репозитории кода). */
function insideWorkTree(target: string): boolean {
  let dir = target;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

function writeReadOnly(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) chmodSync(path, 0o644);
  writeFileSync(path, content);
  chmodSync(path, 0o444);
}

/**
 * Копия всех файлов репозитория задач в папку человека — только для чтения.
 * Пишем только в пустую папку или в свою прошлую копию того же проекта, и
 * никогда внутрь рабочей копии git: так копия не попадёт в репозиторий кода.
 * Файлы помечаются «только чтение»; правленные вручную не перезаписываются
 * без `force`, чтобы не потерять чужой текст молча.
 */
export function exportStore(dir: string, entries: readonly StoreEntry[], target: string, project: string, force = false): ExportResult {
  const result: ExportResult = { written: 0, removed: 0, modified: [] };
  const manifest = readManifest(target);
  if (manifest && manifest.project !== project) return { ...result, refused: 'other-project' };
  if (!manifest && existsSync(target) && readdirSync(target).length > 0) return { ...result, refused: 'foreign-folder' };
  if (insideWorkTree(target)) return { ...result, refused: 'inside-repo' };

  const previous = manifest?.files ?? {};
  const isModified = (rel: string): boolean => {
    const path = join(target, rel);
    return previous[rel] !== undefined && existsSync(path) && statSync(path).isFile() && blobSha(readFileSync(path)) !== previous[rel];
  };

  const blobs = readBlobs(
    dir,
    entries.map((e) => e.sha),
  );
  const next: Record<string, string> = {};
  for (const e of entries) {
    const path = join(target, e.path);
    if (!force && isModified(e.path)) {
      result.modified.push(e.path);
      next[e.path] = previous[e.path];
      continue;
    }
    next[e.path] = e.sha;
    if (existsSync(path) && blobSha(readFileSync(path)) === e.sha) continue;
    writeReadOnly(path, blobs.get(e.sha) ?? Buffer.alloc(0));
    result.written += 1;
  }
  for (const rel of Object.keys(previous)) {
    if (next[rel] !== undefined) continue;
    if (!force && isModified(rel)) {
      result.modified.push(rel);
      continue;
    }
    const path = join(target, rel);
    if (existsSync(path)) {
      chmodSync(path, 0o644);
      rmSync(path);
      result.removed += 1;
    }
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, EXPORT_MANIFEST), `${JSON.stringify({ project, files: next }, null, 2)}\n`);
  result.modified.sort();
  return result;
}
