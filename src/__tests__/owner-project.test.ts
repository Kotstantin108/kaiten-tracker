/**
 * Скрипты владельца по адресу репозитория задач: хранилище перед чтением
 * забирает свежие задачи. Сети нет: «GitHub» — bare-репозиторий во временной папке.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOwnerProject } from '../owner-project.js';
import { cloneStore, listEntries } from '../task-store.js';

const GIT_TIMEOUT = 30_000;

const CONFIG = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [{ name: 'acme-app', label: 'Acme-app' }],
  teams: ['Разработка'],
  defaultTeam: 'Разработка',
  people: { people: { alice: { name: 'Алиса' } }, emails: { 'alice@example.com': 'alice' } },
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

let tmp: string;
let remote: string;
let seed: string;
let store: string;
let url: string;
const savedStore = process.env.KAITEN_STORE;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kaiten-owner-test-'));
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';
  remote = join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', remote);
  seed = join(tmp, 'seed');
  git(tmp, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'kaiten.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  store = join(tmp, 'store.git');
  cloneStore(remote, store);
  process.env.KAITEN_STORE = store;
  // Адрес, а не папка: папку скрипты читают как рабочую копию.
  url = pathToFileURL(remote).href;
});

afterAll(() => {
  if (savedStore === undefined) delete process.env.KAITEN_STORE;
  else process.env.KAITEN_STORE = savedStore;
  rmSync(tmp, { recursive: true, force: true });
});

describe('скрипт владельца по адресу', { timeout: GIT_TIMEOUT }, () => {
  it('задачу, отправленную после kaiten pull, видит', () => {
    mkdirSync(join(seed, 'active'), { recursive: true });
    writeFileSync(join(seed, 'active', 'fresh.md'), 'новая\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'новая задача');
    git(seed, 'push', '-q', 'origin', 'main');
    expect(listEntries(store).some((e) => e.path === 'active/fresh.md')).toBe(false);

    const owner = loadOwnerProject(['--tasks', url]);
    expect(owner.source.kind).toBe('store');
    expect(listEntries(store).some((e) => e.path === 'active/fresh.md')).toBe(true);
  });

  it('свежие задачи не получить — отказ, а не план по старым', () => {
    renameSync(remote, `${remote}.off`);
    try {
      expect(() => loadOwnerProject(['--tasks', url])).toThrow(/не получены/);
    } finally {
      renameSync(`${remote}.off`, remote);
    }
  });
});
