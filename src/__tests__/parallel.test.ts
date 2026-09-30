/**
 * Несколько агентов одновременно: на одной машине (одно хранилище) и на
 * разных (свои хранилища, один общий репозиторий). Каждый — отдельный процесс,
 * как в жизни: замки и пересборка проверяются на настоящей гонке, а не на
 * вызовах по очереди. Сети нет: «GitHub» — bare-репозиторий во временной папке.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import { readJournal, syncStore } from '../store-write.js';
import { cloneStore } from '../task-store.js';

const WORKER = fileURLToPath(new URL('./parallel-worker.ts', import.meta.url));
const IDS = ['01K5ZQ3R8F2K9M4N7P0T5V8W4A', '01K5ZQ3R8F2K9M4N7P0T5V8W4B', '01K5ZQ3R8F2K9M4N7P0T5V8W4C', '01K5ZQ3R8F2K9M4N7P0T5V8W4D'];
const PER_AGENT = 4;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

function taskFile(id: string, n: number): string {
  const fm = FrontmatterSchema.parse({
    id,
    title: `Сделать задачу ${n}`,
    summary: 'Задача для теста параллельной записи.',
    type: 'story',
    status: 'in-progress',
    repo: 'acme-app',
    created: '2026-09-16',
    created_by: 'alice',
    updated: '2026-09-16',
  });
  return serializeTaskDocument(fm, '## Критерии готовности\n\n- [ ] Пункт\n');
}

let tmp: string;

function makeRemote(name: string): string {
  const remote = join(tmp, `${name}.git`);
  git(tmp, 'init', '-q', '--bare', remote);
  const seed = join(tmp, `${name}-seed`);
  git(tmp, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, 'active'));
  IDS.forEach((id, i) => writeFileSync(join(seed, 'active', `task-${i}.md`), taskFile(id, i)));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  return remote;
}

function agent(store: string, id: string, tag: string): Promise<{ tag: string; problems: string[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER, store, id, String(PER_AGENT), tag], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(out) as { tag: string; problems: string[] };
        // С KAITEN_DEBUG рядом с проблемой виден сырой ответ git.
        resolve({ tag: parsed.tag, problems: parsed.problems.length > 0 && err ? [...parsed.problems, err.trim()] : parsed.problems, code });
      } catch {
        reject(new Error(`агент ${tag} завершился с кодом ${code}: ${err.slice(0, 500)}`));
      }
    });
  });
}

function remoteLog(remote: string, n: number): string {
  return git(remote, 'show', `main:active/task-${n}.log.md`);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kaiten-parallel-test-'));
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
  for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('параллельная запись', { timeout: 240_000 }, () => {
  it('четыре агента на одной машине: одно хранилище, разные задачи — ничего не теряется', async () => {
    const remote = makeRemote('one');
    const store = join(tmp, 'one-store.git');
    cloneStore(remote, store);

    const results = await Promise.all(IDS.map((id, i) => agent(store, id, `a${i}`)));
    for (const r of results) expect(r, r.tag).toMatchObject({ code: 0, problems: [] });
    // Хвост, который кто-то не успел отправить сам («занято»), уходит следующим проходом.
    syncStore(store);

    expect(readJournal(store).pending).toHaveLength(0);
    IDS.forEach((_, i) => {
      const log = remoteLog(remote, i);
      for (let n = 0; n < PER_AGENT; n += 1) expect(log, `a${i}-${n}`).toContain(`a${i}-${n}`);
      // Каждая запись — ровно один раз: пересборка не применяет операцию дважды.
      expect(log.match(/^## \[/gm)).toHaveLength(PER_AGENT);
    });
  });

  it('две машины по два агента: общий репозиторий, гонка отправок — ничего не теряется', async () => {
    const remote = makeRemote('two');
    const stores = [join(tmp, 'two-a.git'), join(tmp, 'two-b.git')];
    for (const s of stores) cloneStore(remote, s);

    const results = await Promise.all(IDS.map((id, i) => agent(stores[i % 2], id, `b${i}`)));
    for (const r of results) expect(r, r.tag).toMatchObject({ code: 0, problems: [] });
    for (const s of stores) syncStore(s);
    for (const s of stores) expect(readJournal(s).pending, s).toHaveLength(0);

    IDS.forEach((_, i) => {
      const log = remoteLog(remote, i);
      expect(log.match(/^## \[/gm)).toHaveLength(PER_AGENT);
      for (let n = 0; n < PER_AGENT; n += 1) expect(log).toContain(`b${i}-${n}`);
    });
  });

  it('один агент пишет в ту же задачу, что и другой: записи обоих на месте', async () => {
    const remote = makeRemote('same');
    const store = join(tmp, 'same-store.git');
    cloneStore(remote, store);

    const results = await Promise.all([agent(store, IDS[0], 'x'), agent(store, IDS[0], 'y')]);
    for (const r of results) expect(r, r.tag).toMatchObject({ code: 0, problems: [] });
    syncStore(store);

    const log = remoteLog(remote, 0);
    expect(log.match(/^## \[/gm)).toHaveLength(PER_AGENT * 2);
    for (const tag of ['x', 'y']) for (let n = 0; n < PER_AGENT; n += 1) expect(log).toContain(`${tag}-${n}`);
  });
});
