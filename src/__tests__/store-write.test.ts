/**
 * Запись без рабочей копии и отправка: два разработчика, одна общая история.
 * Сети нет: «GitHub» — bare-репозиторий во временной папке.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import { newTaskText } from '../core/task-ops.js';
import { readJournal, recordOp, syncStore, takeNotices, withLock } from '../store-write.js';
import { cloneStore, listEntries, readStoreTree, StoreError } from '../task-store.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const DATE = '2026-09-28';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const TASK = serializeTaskDocument(
  FrontmatterSchema.parse({
    id: ID,
    title: 'Починить таймаут вебхука',
    summary: 'Оплата иногда зависает.',
    type: 'bug',
    status: 'ready',
    repo: 'acme-app',
    created: '2026-09-16',
    created_by: 'alice',
    updated: '2026-09-16',
  }),
  '## Критерии\n\n- [ ] Тест на таймаут\n- [ ] Ретраи\n',
);

let tmp: string;
let remote: string;

function taskText(store: string, path = 'active/webhook.md'): string | undefined {
  return readStoreTree(store, listEntries(store)).files.find((f) => f.path === path)?.text;
}

function remoteText(path = 'active/webhook.md'): string {
  return git(remote, 'show', `main:${path}`);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kaiten-write-test-'));
  // Имя для истории изменений — как у разработчика с настроенным git.
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';
  remote = join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', remote);
  const seed = join(tmp, 'seed');
  git(tmp, 'clone', '-q', remote, seed);
  execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(join(seed, 'active'))})`]);
  writeFileSync(join(seed, 'active', 'webhook.md'), TASK);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('запись и отправка', () => {
  let a: string;
  let b: string;

  beforeAll(() => {
    a = join(tmp, 'a.git');
    b = join(tmp, 'b.git');
    cloneStore(remote, a);
    cloneStore(remote, b);
  });

  it('запись видна сразу, общим — после отправки', () => {
    const r = recordOp(a, { kind: 'check', id: ID, items: ['Тест на таймаут'], checked: true }, 'отметка', DATE);
    expect(r).toMatchObject({ changed: true });
    expect(taskText(a)).toContain('- [x] Тест на таймаут');
    expect(remoteText()).toContain('- [ ] Тест на таймаут');
    expect(readJournal(a).pending).toHaveLength(1);

    expect(syncStore(a)).toMatchObject({ sent: 1, failed: [] });
    expect(remoteText()).toContain('- [x] Тест на таймаут');
    expect(readJournal(a).pending).toHaveLength(0);
  });

  it('повтор той же отметки ничего не пишет', () => {
    expect(recordOp(a, { kind: 'check', id: ID, items: ['Тест на таймаут'], checked: true }, 'отметка', DATE)).toMatchObject({ changed: false });
    expect(readJournal(a).pending).toHaveLength(0);
  });

  it('чужое изменение не теряется: своё применяется поверх свежего', () => {
    // B записал, ещё не зная об отметке A.
    recordOp(b, { kind: 'log', id: ID, text: 'воспроизвёл' }, 'журнал', DATE);
    expect(taskText(b)).toContain('- [ ] Тест на таймаут');
    expect(syncStore(b)).toMatchObject({ sent: 1, changed: true });
    expect(remoteText()).toContain('- [x] Тест на таймаут');
    expect(remoteText('active/webhook.log.md')).toContain('воспроизвёл');
    expect(taskText(b)).toContain('- [x] Тест на таймаут');
  });

  it('операция, ставшая невозможной, не отправляется и сообщается один раз', () => {
    syncStore(a);
    recordOp(b, { kind: 'block', id: ID, reason: 'ждём доступ' }, 'блокировка webhook', DATE);
    recordOp(a, { kind: 'cancel', id: ID, reason: 'дубль' }, 'отмена webhook', DATE);
    syncStore(a);
    const result = syncStore(b);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ what: 'блокировка webhook' });
    expect(result.failed[0].reason).toContain('cancelled');
    expect(readJournal(b).pending).toHaveLength(0);
    expect(existsSync(join(remote))).toBe(true);
    expect(remoteText('archive/2026-09/webhook.md')).toContain('status: cancelled');
    expect(takeNotices(b).failed).toHaveLength(1);
    expect(takeNotices(b).failed).toHaveLength(0);
  });

  it('новая задача', () => {
    const text = newTaskText(
      { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B', slug: 'new-one', title: 'Проверить отправку', summary: 'Проверка.', type: 'tech', repo: 'acme-app', createdBy: 'alice', createdVia: 'agent' },
      DATE,
    );
    if (typeof text !== 'string') throw new Error(text.error);
    expect(recordOp(a, { kind: 'new', path: 'active/new-one.md', text }, 'новая', DATE)).toMatchObject({ changed: true });
    syncStore(a);
    expect(remoteText('active/new-one.md')).toContain('Проверить отправку');
  });
});

describe('пустой репозиторий задач', () => {
  it('первая задача создаёт ветку', () => {
    const empty = join(tmp, 'empty.git');
    git(tmp, 'init', '-q', '--bare', empty);
    const store = join(tmp, 'empty-store.git');
    cloneStore(empty, store);
    const text = newTaskText(
      { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3C', slug: 'first', title: 'Завести задачи', summary: 'Первая.', type: 'tech', repo: 'acme-app', createdBy: 'alice', createdVia: 'human' },
      DATE,
    );
    if (typeof text !== 'string') throw new Error(text.error);
    recordOp(store, { kind: 'new', path: 'active/first.md', text }, 'новая', DATE);
    expect(syncStore(store).sent).toBe(1);
    expect(git(empty, 'show', 'main:active/first.md')).toContain('Завести задачи');
  });
});

describe('замки', () => {
  it('брошенный замок умершего процесса снимается', () => {
    const dir = mkdtempSync(join(tmp, 'lock-'));
    writeFileSync(join(dir, 'x.lock'), '999999 2026-09-28T00:00:00Z');
    expect(withLock(dir, 'x.lock', () => 42)).toBe(42);
    expect(existsSync(join(dir, 'x.lock'))).toBe(false);
  });

  it('живой замок — ждём, потом «занято»', () => {
    const dir = mkdtempSync(join(tmp, 'lock-'));
    writeFileSync(join(dir, 'x.lock'), `${process.pid} now`);
    expect(() => withLock(dir, 'x.lock', () => 1, { waitMs: 100 })).toThrow(StoreError);
  });
});
