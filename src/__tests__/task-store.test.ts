/**
 * Хранилище задач без рабочей копии и копия для людей. Сети нет: «GitHub» —
 * bare-репозиторий во временной папке, git — локальный.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { blobSha, cloneStore, COPY_MANIFEST, syncCopy, isStore, listEntries, readBlobs, readStoreTree, StoreError, updateStore } from '../task-store.js';

const GIT = ['-c', 'core.autocrlf=false', '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function put(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

let tmp: string;
let author: string;
let remote: string;
let store: string;

const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0d, 0x0a, 0xff]);

function commit(message: string): void {
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', message);
  git(author, 'push', '-q', 'origin', 'main');
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kaiten-store-test-'));
  remote = join(tmp, 'remote.git');
  author = join(tmp, 'author');
  store = join(tmp, 'store', 'acme-tasks.git');
  git(tmp, 'init', '-q', '--bare', remote);
  git(tmp, 'clone', '-q', remote, author);
  put(author, 'active/onboarding.md', '---\nid: x\n---\nОнбординг\r\nс CRLF внутри\n');
  put(author, 'active/onboarding.log.md', '## [2026-09-20] создана\n');
  put(author, 'archive/2026-09/старое.md', '---\nid: y\n---\nкириллица в имени\n');
  put(author, 'attachments/onboarding/img/scheme.png', BINARY);
  put(author, 'README.md', 'не задача\n');
  commit('init');
  cloneStore(remote, store);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('хранилище', () => {
  it('без рабочей копии: на диске нет файлов задач', () => {
    expect(isStore(store)).toBe(true);
    expect(existsSync(join(store, 'active'))).toBe(false);
  });

  it('читает задачи и журналы байт в байт, имена не экранированы', () => {
    const entries = listEntries(store);
    expect(entries.map((e) => e.path).sort()).toEqual([
      'README.md',
      'active/onboarding.log.md',
      'active/onboarding.md',
      'archive/2026-09/старое.md',
      'attachments/onboarding/img/scheme.png',
    ]);
    const tree = readStoreTree(store, entries);
    expect(tree.files.map((f) => f.path)).toEqual(['active/onboarding.md', 'archive/2026-09/старое.md']);
    expect(tree.files[0].text).toContain('Онбординг\r\nс CRLF');
    expect(tree.logs.get('active/onboarding.md')).toContain('создана');

    const png = entries.find((e) => e.path.endsWith('.png'));
    expect(png?.size).toBe(BINARY.length);
    expect(readBlobs(store, [png?.sha ?? ''])).toEqual(new Map([[png?.sha, BINARY]]));
  });

  it('pull: новое приезжает, повтор — без изменений', () => {
    put(author, 'active/new-task.md', '---\nid: z\n---\n');
    commit('новая задача');
    expect(updateStore(store)).toBe(true);
    expect(listEntries(store).some((e) => e.path === 'active/new-task.md')).toBe(true);
    expect(updateStore(store)).toBe(false);
  });

  it('обычная папка — не хранилище', () => {
    expect(isStore(author)).toBe(false);
    expect(() => updateStore(join(tmp, 'нет-такой'))).toThrow(StoreError);
  });

  it('недоступный адрес — ошибка с видом, без текста git', () => {
    try {
      cloneStore(join(tmp, 'missing.git'), join(tmp, 'store2', 'x.git'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).message).not.toContain(tmp);
    }
    // Оборванная загрузка не оставляет полухранилища, которое потом не открыть.
    expect(existsSync(join(tmp, 'store2', 'x.git'))).toBe(false);
  });

  it('blobSha совпадает с git', () => {
    const file = join(tmp, 'blob.bin');
    writeFileSync(file, BINARY);
    expect(blobSha(BINARY)).toBe(git(tmp, 'hash-object', file));
  });
});

describe('копия для людей', () => {
  const target = (): string => join(tmp, 'copy', 'acme');

  it('пишет все файлы только для чтения и помнит, что написала', () => {
    const r = syncCopy(store, listEntries(store), target(), 'acme');
    expect(r).toEqual({ written: 6, removed: 0, modified: [] });
    expect(readFileSync(join(target(), 'attachments/onboarding/img/scheme.png'))).toEqual(BINARY);
    expect(readFileSync(join(target(), 'archive/2026-09/старое.md'), 'utf8')).toContain('кириллица');
    expect(statSync(join(target(), 'active/onboarding.md')).mode & 0o200).toBe(0);
    expect(existsSync(join(target(), COPY_MANIFEST))).toBe(true);
  });

  it('повтор ничего не пишет; удалённая из задач — удаляется из копии', () => {
    expect(syncCopy(store, listEntries(store), target(), 'acme')).toEqual({ written: 0, removed: 0, modified: [] });
    rmSync(join(author, 'active/new-task.md'));
    commit('убрать');
    updateStore(store);
    expect(syncCopy(store, listEntries(store), target(), 'acme')).toEqual({ written: 0, removed: 1, modified: [] });
    expect(existsSync(join(target(), 'active/new-task.md'))).toBe(false);
  });

  it('правку в копии не затирает молча; удалённый из копии файл возвращается как в задачах', () => {
    const path = join(target(), 'active/onboarding.md');
    chmodSync(path, 0o644);
    writeFileSync(path, 'правка руками\n');
    expect(syncCopy(store, listEntries(store), target(), 'acme').modified).toEqual(['active/onboarding.md']);
    expect(readFileSync(path, 'utf8')).toBe('правка руками\n');
    // И на следующем прогоне — снова предупреждение, а не «уже как было».
    expect(syncCopy(store, listEntries(store), target(), 'acme').modified).toEqual(['active/onboarding.md']);
    chmodSync(path, 0o644);
    rmSync(path);
    expect(syncCopy(store, listEntries(store), target(), 'acme').modified).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('Онбординг');
  });

  it('не пишет в чужую непустую папку, в репозиторий git и поверх копии другого проекта', () => {
    const foreign = join(tmp, 'foreign');
    put(foreign, 'notes.txt', 'моё');
    expect(syncCopy(store, listEntries(store), foreign, 'acme').refused).toBe('foreign-folder');
    expect(syncCopy(store, listEntries(store), join(author, 'tasks-copy'), 'acme').refused).toBe('inside-repo');
    expect(existsSync(join(author, 'tasks-copy'))).toBe(false);
    expect(syncCopy(store, listEntries(store), target(), 'globex').refused).toBe('other-project');
  });
});
