/**
 * Шаг Kaiten после отправки: выключатель, ключ карточки — в задачу через
 * журнал и git, второй проход — без записей. Kaiten поддельный, git локальный.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LoadedProject, People } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import type { Context } from '../kaiten-cli.js';
import { readJournal, takeNotices } from '../store-write.js';
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
    people: { people: {}, emails: {} },
  } as unknown as LoadedProject & { people: People };
  ctx = { loaded, title: 'Acme', tasksUrl: 'https://example.com/acme/acme-tasks.git', currentRepo: 'acme-app', store, workDir: tmp };
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

  it('ошибка Kaiten — следующей команде, один раз; повтор той же ошибки не копится', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    fake.failOn = (method, path) => (method === 'GET' && path === '/cards' ? { status: 403, body: { message: 'Нет доступа к доске' } } : null);
    expect(await syncWithKaiten(ctx, fake.client)).toBeNull();
    await syncWithKaiten(ctx, fake.client);
    expect(readJournal(ctx.store).kaiten?.errors).toEqual([expect.objectContaining({ what: 'синхронизация', reason: 'Нет доступа к доске' })]);
    expect(takeNotices(ctx.store).kaiten).toHaveLength(1);
    expect(takeNotices(ctx.store).kaiten).toHaveLength(0);
    // Та же ошибка снова — не показывается заново; успешный шаг стирает.
    await syncWithKaiten(ctx, fake.client);
    expect(takeNotices(ctx.store).kaiten).toHaveLength(0);
    fake.failOn = undefined;
    await syncWithKaiten(ctx, fake.client);
    expect(readJournal(ctx.store).kaiten).toBeUndefined();
  });
});

describe('одновременные шаги', { timeout: 60_000 }, () => {
  it('два прогона сразу — одна карточка', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
    // Новая задача без карточки в том же хранилище.
    const seed = join(tmp, 'seed');
    git(seed, 'pull', '-q');
    const fm = FrontmatterSchema.parse({
      id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B',
      title: 'Проверить гонку',
      summary: 'Ровно одна карточка.',
      type: 'tech',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-09-28',
      created_by: 'alice',
      created_via: 'agent',
      updated: '2026-09-28',
    });
    writeFileSync(join(seed, 'active', 'race.md'), serializeTaskDocument(fm, '\nТекст.\n'));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'race');
    git(seed, 'push', '-q', 'origin', 'main');
    const { syncStore } = await import('../store-write.js');
    syncStore(ctx.store);

    const { syncWithKaiten } = await import('../kaiten-cli.js');
    // Свои номера карточек: у прошлого поддельного Kaiten они те же.
    const fake = fakeKaiten({ firstId: 950_000 });
    await Promise.all([syncWithKaiten(ctx, fake.client), syncWithKaiten(ctx, fake.client)]);
    expect([...fake.cards.values()].filter((c) => c.title === 'Проверить гонку')).toHaveLength(1);
  });
});

describe('статус — сначала карточка', { timeout: 30_000 }, () => {
  async function setup(sync: boolean) {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: sync } }));
    const { moveCardFirst, loadTasks } = await import('../kaiten-cli.js');
    const withColumns = {
      ...ctx,
      loaded: {
        ...ctx.loaded,
        project: { ...ctx.loaded.project, ignoreCards: [123], mapping: { ...ctx.loaded.project.mapping, columns: { inbox: 101, blocked: 105, cancelled: 108 } } },
      },
    } as Context;
    const task = loadTasks(withColumns).index.tasks.find((t) => t.slug === 'step');
    if (!task) throw new Error('нет задачи');
    const fake = fakeKaiten();
    const cardId = Number(task.fm.tracker);
    fake.cards.set(cardId, { id: cardId, title: task.fm.title, board_id: 10, column_id: 101, external_id: null, description: '', properties: {}, parents_ids: null, checklists: [], comments: [], archived: false });
    return { moveCardFirst, ctx: withColumns, task, fake, cardId };
  }

  it('синхронизация выключена — карточку не трогаем', async () => {
    const s = await setup(false);
    expect(await s.moveCardFirst(s.ctx, s.task, 'cancelled', s.fake.client)).toBe('off');
    expect(s.fake.writes).toEqual([]);
  });

  it('включена — карточка в нужной колонке до записи файла', async () => {
    const s = await setup(true);
    expect(await s.moveCardFirst(s.ctx, s.task, 'blocked', s.fake.client)).toBe('moved');
    expect(s.fake.cards.get(s.cardId)?.column_id).toBe(105);
  });

  it('ограничение доски — команда останавливается словами владельца', async () => {
    const s = await setup(true);
    s.fake.failOn = () => ({ status: 400, body: { error_text: 'Из «В работе» — не в «Отменено»' } });
    await expect(s.moveCardFirst(s.ctx, s.task, 'cancelled', s.fake.client)).rejects.toThrow('Kaiten не разрешил — Из «В работе» — не в «Отменено»');
  });

  it('карточка из списка владельца — не трогаем', async () => {
    const s = await setup(true);
    const ignored = { ...s.task, fm: { ...s.task.fm, tracker: '123' } };
    expect(await s.moveCardFirst(s.ctx, ignored, 'cancelled', s.fake.client)).toBe('none');
    expect(s.fake.writes).toEqual([]);
  });
});
