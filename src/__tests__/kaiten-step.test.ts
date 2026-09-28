/**
 * Шаг Kaiten после отправки: выключатель, ключ карточки — в задачу через
 * журнал и git, второй проход — без записей. Kaiten поддельный, git локальный.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LoadedProject } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import type { Context } from '../kaiten-cli.js';
import { readJournal } from '../store-write.js';
import { cloneStore } from '../task-store.js';
import { fakeKaiten } from './fake-kaiten.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-step-test-'));
const settingsPath = join(tmp, 'settings.json');
// Путь настроек читается при загрузке модуля — задать до импорта.
process.env.KAITEN_SETTINGS = settingsPath;
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

let ctx: Context;
let remote: string;

beforeAll(() => {
  remote = join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', remote);
  const seed = join(tmp, 'seed');
  git(tmp, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, 'active'));
  const fm = FrontmatterSchema.parse({
    id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A',
    title: 'Проверить шаг Kaiten',
    summary: 'Карточка появляется сама.',
    type: 'tech',
    status: 'inbox',
    repo: 'acme-app',
    created: '2026-09-28',
    created_by: 'alice',
    created_via: 'agent',
    updated: '2026-09-28',
  });
  writeFileSync(join(seed, 'active', 'step.md'), serializeTaskDocument(fm, '\n## Критерии готовности\n\n- [ ] Работает\n'));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  const store = join(tmp, 'store.git');
  cloneStore(remote, store);
  const loaded = {
    key: 'acme',
    project: {
      title: 'Acme',
      kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
      repos: [{ name: 'acme-app', label: 'Acme-app', branch: 'main', layout: 'folders' }],
      ignoreCards: [],
      retireFields: [],
      mapping: { boardId: 10, laneId: 20, columns: { inbox: 101 }, types: { tech: 3 }, summaryProperty: { id: 4 }, repoProperty: { id: 2, values: { 'acme-app': 21 } } },
    },
    config: { teams: [], projects: {} },
  } as unknown as LoadedProject;
  ctx = { loaded, title: 'Acme', currentRepo: 'acme-app', store, workDir: tmp };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('шаг Kaiten', { timeout: 30_000 }, () => {
  it('выключен — ни одного запроса', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: false } }));
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    expect(await syncWithKaiten(ctx, fake.client)).toBeNull();
    expect(fake.writes).toEqual([]);
  });

  it('включён — карточка создана, ключ в задаче и в общем; второй проход пустой', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const fake = fakeKaiten({ requiredSummaryKey: 'id_4' });
    const run = await syncWithKaiten(ctx, fake.client);
    expect(run?.errors).toEqual([]);
    const card = [...fake.cards.values()][0];
    expect(git(remote, 'show', 'main:active/step.md')).toContain(`tracker: "${card.id}"`);
    expect(readJournal(ctx.store).pending).toHaveLength(0);

    const writes = fake.writes.length;
    const second = await syncWithKaiten(ctx, fake.client);
    expect(second?.plan.actions).toEqual([]);
    expect(fake.writes.length).toBe(writes);
  });

  it('ошибка Kaiten — в журнал для следующей команды', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    fake.failOn = (method, path) => (method === 'GET' && path === '/cards' ? { status: 403, body: { message: 'Нет доступа к доске' } } : null);
    expect(await syncWithKaiten(ctx, fake.client)).toBeNull();
    expect(readJournal(ctx.store).failed.at(-1)).toMatchObject({ what: 'синхронизация с Kaiten', reason: 'Нет доступа к доске' });
  });
});
