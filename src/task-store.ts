/**
 * Хранилище задач проекта на машине разработчика: git без рабочей копии
 * (`clone --bare`). Решение владельца 28.09.2026: единственный путь к задачам
 * — CLI `kaiten`; файлов задач, которые можно открыть или поправить руками,
 * на диске нет. Люди читают задачи на GitHub или в копии для чтения — её
 * включают в настройках (`kaiten-context.ts`), и `kaiten pull` её обновляет.
 *
 * Где лежит: `%LOCALAPPDATA%\kaiten\<tasksRepo>.git` (macOS — `~/Library/
 * Application Support/kaiten`, Linux — `$XDG_DATA_HOME/kaiten`). `KAITEN_STORE`
 * подменяет путь целиком — для тестов и пробных прогонов. Путь не печатается
 * никогда: ни в выводе, ни в ошибках (сырые ошибки git его содержат, поэтому
 * они переводятся в `StoreError` с видом ошибки).
 *
 * Чтение: `ls-tree -r -z` + один `cat-file --batch` на все файлы — замер
 * 28.09 на 908 файлах Acme: ~0,2 с, не медленнее чтения папки.
 * Обновление и запись — `store-write.ts`: локальная ветка = общая + операции
 * журнала, применённые заново.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { TasksTree } from './tasks-files.js';

export type StoreErrorKind = 'no-access' | 'offline' | 'not-found' | 'rejected' | 'refused' | 'no-identity' | 'busy' | 'not-store' | 'other';

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
  // Две отправки столкнулись на одной ветке: сервер отверг вторую не по правилам, а потому что
  // ветка в этот миг менялась («failed to lock», «incorrect old value provided»). Это гонка — повторить, как
  // и обычное «кто-то успел раньше» (тест параллельной записи, 30.09.2026).
  if (/\[remote rejected\].*(?:failed to (?:lock|update ref)|cannot lock ref|unable to lock|but expected|reference already exists|incorrect old value)|cannot lock ref .* but expected/i.test(stderr)) return 'rejected';
  // Сервер отказал по правилам (защищённая ветка, хук) — повтор не поможет.
  if (/\[remote rejected\]|pre-receive hook declined|protected branch/i.test(stderr)) return 'refused';
  // Push отвергнут, потому что кто-то успел раньше, — не ошибка, а повод повторить.
  if (/\[rejected\]/.test(stderr) && /non-fast-forward|fetch first/i.test(stderr)) return 'rejected';
  if (/Please tell me who you are|empty ident|unable to auto-detect email/i.test(stderr)) return 'no-identity';
  if (/Authentication failed|Permission denied|could not read Username|returned error: 403|access denied/i.test(stderr)) return 'no-access';
  if (/Repository not found|does not appear to be a git repository|not found/i.test(stderr)) return 'not-found';
  if (/Could not resolve host|unable to access|timed out|Failed to connect|Connection refused|network/i.test(stderr)) return 'offline';
  return 'other';
}

const GIT_BASE = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false'];

export function git(cwd: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv): Buffer {
  try {
    return execFileSync('git', [...GIT_BASE, ...args], { cwd, input, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30, windowsHide: true });
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    // Сырой текст git — только по запросу: в нём пути хранилища.
    if (process.env.KAITEN_DEBUG) console.error(`git ${args[0]}: ${stderr.trim()}`);
    throw new StoreError(classify(stderr));
  }
}

/** Паузы перед повторами сетевого вызова, мс. `KAITEN_NET_RETRY` (через запятую) — для тестов. */
function retryDelays(): number[] {
  const raw = process.env.KAITEN_NET_RETRY;
  return raw === undefined ? [1500, 4000] : raw.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
}

function pause(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Сетевой вызов git (clone, fetch, push) с повторами при обрыве связи.
 * Живьём 30.09.2026: три агента стартовали одновременно, и у одного `fetch`
 * оборвался, хотя соседние через секунды прошли. Повторяется только
 * «нет связи»: отказ в доступе и отвергнутый push повтор не исправит, а
 * повтор push безопасен — он переносит те же коммиты.
 */
export function gitNetwork(cwd: string, args: string[]): Buffer {
  const delays = retryDelays();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return git(cwd, args);
    } catch (error) {
      if (!(error instanceof StoreError) || error.kind !== 'offline' || attempt >= delays.length) throw error;
      pause(delays[attempt]);
    }
  }
}

export function gitText(cwd: string, args: string[], input?: Buffer | string, env?: NodeJS.ProcessEnv): string {
  return git(cwd, args, input, env).toString('utf8').trim();
}

/** sha коммита по ссылке или `null`, если её нет (пустой репозиторий, ничего не отправлено). */
export function revOrNull(dir: string, ref: string): string | null {
  try {
    return gitText(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null;
  } catch {
    return null;
  }
}

/** Ветка задач: та, на которую смотрит HEAD хранилища (`main`). */
export function storeBranch(dir: string): string {
  return gitText(dir, ['symbolic-ref', '--short', 'HEAD']);
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
    gitNetwork(dirname(dir), ['clone', '--quiet', '--bare', url, dir]);
    // `clone --bare` не заводит refspec: без него `fetch` не обновит origin/*.
    git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    gitNetwork(dir, ['fetch', '--quiet', 'origin']);
  } catch (error) {
    // Полухранилище не оставляем: удалить его человеку нечем — путь не называется.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export interface StoreEntry {
  path: string;
  sha: string;
  size: number;
}

/** Все файлы состояния задач (по умолчанию — локального, с неотправленными изменениями). Пустой репозиторий — пустой список. */
export function listEntries(dir: string, rev = 'HEAD'): StoreEntry[] {
  let out: Buffer;
  try {
    out = git(dir, ['ls-tree', '-r', '-z', '--long', rev]);
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

export const COPY_MANIFEST = '.kaiten-copy.json';

export type CopyRefusal = 'foreign-folder' | 'inside-repo' | 'other-project';

export interface CopyResult {
  refused?: CopyRefusal;
  written: number;
  removed: number;
  /** Файлы копии, изменённые вручную: не перезаписываются; удалённый файл вернётся при следующем обновлении. */
  modified: string[];
}

interface Manifest {
  project: string;
  files: Record<string, string>;
}

function readManifest(target: string): Manifest | null {
  const path = join(target, COPY_MANIFEST);
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
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim() === 'true';
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
 * Файлы помечаются «только чтение»; правленные вручную не перезаписываются,
 * чтобы не потерять чужой текст молча, — вернуть файл как в задачах можно,
 * удалив его из копии.
 */
export function syncCopy(dir: string, entries: readonly StoreEntry[], target: string, project: string): CopyResult {
  const result: CopyResult = { written: 0, removed: 0, modified: [] };
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
    if (isModified(e.path)) {
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
    if (isModified(rel)) {
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
  writeFileSync(join(target, COPY_MANIFEST), `${JSON.stringify({ project, files: next }, null, 2)}\n`);
  result.modified.sort();
  return result;
}
