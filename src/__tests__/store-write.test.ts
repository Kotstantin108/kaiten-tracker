/**
 * Запись без рабочей копии и отправка: два разработчика, одна общая история.
 * Сети нет: «GitHub» — bare-репозиторий во временной папке.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as documentModule from '../core/document.js';
import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import { newTaskText } from '../core/task-ops.js';
import { readJournal, recordOp, sendInBackground, SEND_QUEUE, storeBlob, syncStore, takeNotices, tryLock, withLock } from '../store-write.js';
import { cloneStore, listEntries, readBlobs, readStoreTree, StoreError } from '../task-store.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
/** git на Windows под нагрузкой всего набора медленный: 5 с по умолчанию мало. */
const GIT_TIMEOUT = 30_000;
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

describe('запись и отправка', { timeout: GIT_TIMEOUT }, () => {
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
    recordOp(b, { kind: 'log', id: ID, text: 'воспроизвёл' }, 'журнал', DATE, { by: 'bob' });
    expect(taskText(b)).toContain('- [ ] Тест на таймаут');
    expect(syncStore(b)).toMatchObject({ sent: 1, changed: true });
    expect(remoteText()).toContain('- [x] Тест на таймаут');
    // Пересборка поверх чужого не теряет автора записи.
    expect(remoteText('active/webhook.log.md')).toMatch(/^## \[[^\]]* · bob\] воспроизвёл$/m);
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

describe('обрывы и гонки', { timeout: GIT_TIMEOUT }, () => {
  /** Свежий «GitHub» с одной задачей и хранилища к нему. */
  function world(name: string, stores: number): { origin: string; stores: string[] } {
    const origin = join(tmp, `${name}.git`);
    git(tmp, 'clone', '-q', '--bare', remote, origin);
    // Задача в исходном виде — предыдущие тесты её отменили.
    const seed = join(tmp, `${name}-seed`);
    git(tmp, 'clone', '-q', origin, seed);
    execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(join(seed, 'active'))}, { recursive: true })`]);
    writeFileSync(join(seed, 'active', 'webhook.md'), TASK);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'reset', '--allow-empty');
    git(seed, 'push', '-q', 'origin', 'main');
    return {
      origin,
      stores: Array.from({ length: stores }, (_, i) => {
        const s = join(tmp, `${name}-${i}.git`);
        cloneStore(origin, s);
        return s;
      }),
    };
  }
  const logOf = (origin: string): string => git(origin, 'show', 'main:active/webhook.log.md');

  it('обрыв после push: следующая отправка не применяет операции второй раз', () => {
    const { origin, stores } = world('crash', 1);
    recordOp(stores[0], { kind: 'log', id: ID, text: 'ровно один раз' }, 'журнал', DATE);
    expect(() =>
      syncStore(stores[0], {
        afterPush: () => {
          throw new Error('процесс убит');
        },
      }),
    ).toThrow('процесс убит');
    expect(readJournal(stores[0]).pending).toHaveLength(1);
    expect(syncStore(stores[0])).toMatchObject({ sent: 1, failed: [] });
    expect(logOf(origin).match(/ровно один раз/g)).toHaveLength(1);
    expect(readJournal(stores[0]).pending).toHaveLength(0);
  });

  it('кто-то отправил между сборкой и push: повтор, оба изменения на месте', () => {
    const { origin, stores } = world('race', 2);
    recordOp(stores[0], { kind: 'check', id: ID, items: ['Ретраи'], checked: true }, 'отметка', DATE);
    let raced = false;
    const result = syncStore(stores[0], {
      beforePush: () => {
        if (raced) return;
        raced = true;
        recordOp(stores[1], { kind: 'log', id: ID, text: 'успел раньше' }, 'журнал', DATE);
        syncStore(stores[1]);
      },
    });
    expect(result).toMatchObject({ sent: 1, failed: [] });
    expect(git(origin, 'show', 'main:active/webhook.md')).toContain('- [x] Ретраи');
    expect(logOf(origin)).toContain('успел раньше');
  });

  it('сервер отказал по правилам — не «гонка», повторов нет', () => {
    const { origin, stores } = world('refused', 1);
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
    execFileSync('node', ['-e', `require('fs').chmodSync(${JSON.stringify(join(origin, 'hooks', 'pre-receive'))}, 0o755)`]);
    recordOp(stores[0], { kind: 'log', id: ID, text: 'не примут' }, 'журнал', DATE);
    try {
      syncStore(stores[0]);
      expect.unreachable();
    } catch (error) {
      expect((error as StoreError).kind).toBe('refused');
    }
    expect(readJournal(stores[0]).sendProblem?.kind).toBe('refused');
    expect(readJournal(stores[0]).pending).toHaveLength(1);
  });

  it('правка, опоздавшая к чужой, не пропадает: текст сохранён', () => {
    const { stores } = world('edit', 2);
    const current = taskText(stores[0]) ?? '';
    const { contentHash, parseTaskDocument } = documentModule;
    const raw = parseTaskDocument(current);
    const base = contentHash(FrontmatterSchema.parse(raw.data), raw.body);
    recordOp(stores[0], { kind: 'edit', id: ID, text: current.replace('Оплата иногда зависает.', 'Моя «Суть».'), baseHash: base }, 'правка webhook', DATE);
    recordOp(stores[1], { kind: 'edit', id: ID, text: current.replace('Оплата иногда зависает.', 'Чужая «Суть».'), baseHash: base }, 'правка webhook', DATE);
    syncStore(stores[1]);
    const result = syncStore(stores[0]);
    expect(result.failed).toHaveLength(1);
    const kept = /текст сохранён в (.+)$/.exec(result.failed[0].reason)?.[1] ?? '';
    expect(readFileSync(kept, 'utf8')).toContain('Моя «Суть».');
  });
});

describe('пустой репозиторий задач', { timeout: GIT_TIMEOUT }, () => {
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

describe('замки', { timeout: GIT_TIMEOUT }, () => {
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

describe('вложения', { timeout: GIT_TIMEOUT }, () => {
  it('файл любого содержимого виден сразу и уходит общим; повтор с тем же именем заменяет', () => {
    const store = join(tmp, 'attach.git');
    cloneStore(remote, store);
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    const first = recordOp(store, { kind: 'attach', id: ID, name: 'data/raw.bin', blob: storeBlob(store, bytes) }, 'вложение', DATE);
    expect(first).toMatchObject({ changed: true });
    const entry = listEntries(store).find((e) => e.path === 'attachments/webhook/data/raw.bin');
    expect(entry?.size).toBe(bytes.length);
    expect(readBlobs(store, [entry?.sha ?? '']).get(entry?.sha ?? '')?.equals(bytes)).toBe(true);
    // То же содержимое ещё раз — менять нечего.
    expect(recordOp(store, { kind: 'attach', id: ID, name: 'data/raw.bin', blob: storeBlob(store, bytes) }, 'вложение', DATE)).toMatchObject({ changed: false });

    recordOp(store, { kind: 'attach', id: ID, name: 'HANDOFF.md', blob: storeBlob(store, Buffer.from('первая версия\n')) }, 'вложение', DATE);
    recordOp(store, { kind: 'attach', id: ID, name: 'HANDOFF.md', blob: storeBlob(store, Buffer.from('вторая версия\n')) }, 'вложение', DATE);
    expect(syncStore(store)).toMatchObject({ sent: 3, failed: [] });
    expect(remoteText('attachments/webhook/HANDOFF.md')).toBe('вторая версия');
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'main')).toContain('attachments/webhook/data/raw.bin');
  });

  it('объекта нет в хранилище — операция не записывается', () => {
    const store = join(tmp, 'attach.git');
    expect(recordOp(store, { kind: 'attach', id: ID, name: 'x.md', blob: 'b'.repeat(40) }, 'вложение', DATE)).toMatchObject({ error: expect.stringContaining('приложите файл ещё раз') });
  });
});

describe('очередь фоновых отправок', { timeout: GIT_TIMEOUT }, () => {
  it('место в очереди одно: занято живым процессом — второй не ждёт; умершим — занимает', () => {
    const dir = mkdtempSync(join(tmp, 'queue-'));
    const leave = tryLock(dir, 'q.lock');
    expect(leave).not.toBeNull();
    expect(tryLock(dir, 'q.lock')).toBeNull();
    leave?.();
    writeFileSync(join(dir, 'q.lock'), '999999999 когда-то');
    const again = tryLock(dir, 'q.lock');
    expect(again).not.toBeNull();
    again?.();
    expect(existsSync(join(dir, 'q.lock'))).toBe(false);
  });

  it('пока кто-то ждёт в очереди, фоновая отправка выходит сразу, а операция остаётся в журнале', () => {
    const store = join(tmp, 'queue-store.git');
    cloneStore(remote, store);
    recordOp(store, { kind: 'log', id: ID, text: 'запись под очередью' }, 'журнал', DATE);
    const leave = tryLock(store, SEND_QUEUE);
    sendInBackground(store);
    expect(readJournal(store).pending).toHaveLength(1);
    leave?.();
    // Место свободно — отправка проходит и освобождает его за собой.
    sendInBackground(store);
    expect(readJournal(store).pending).toHaveLength(0);
    expect(existsSync(join(store, SEND_QUEUE))).toBe(false);
    // Где лежит задача к этому моменту (прошлые тесты её двигали) — неважно: запись дошла до общего.
    expect(git(remote, 'grep', '-l', 'запись под очередью', 'main')).toContain('webhook.log.md');
  });
});
