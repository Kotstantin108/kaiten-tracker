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

describe('файлы карточки из хранилища', { timeout: 60_000 }, () => {
  it('вложения (и во вложенной папке) — в новую карточку; журнал — ссылкой, запись в него файлов карточки не трогает', async () => {
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
    const seed = join(tmp, 'seed');
    git(seed, 'pull', '-q');
    const fm = FrontmatterSchema.parse({
      id: '01K5ZQ3R8F2K9M4N7P0T5V8W3C',
      title: 'Проверить файлы',
      summary: 'Вложения видны в карточке.',
      type: 'tech',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-09-28',
      created_by: 'alice',
      created_via: 'agent',
      updated: '2026-09-28',
    });
    writeFileSync(join(seed, 'active', 'files.md'), serializeTaskDocument(fm, '\nТекст.\n'));
    writeFileSync(join(seed, 'active', 'files.log.md'), '## [2026-09-28] Начал\n\nЧерновик приложен.\n');
    mkdirSync(join(seed, 'attachments', 'files', 'img'), { recursive: true });
    writeFileSync(join(seed, 'attachments', 'files', 'DRAFT.md'), '# Черновик\n');
    writeFileSync(join(seed, 'attachments', 'files', 'img', 'scheme.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'files');
    git(seed, 'push', '-q', 'origin', 'main');
    const { recordOp, syncStore } = await import('../store-write.js');
    syncStore(ctx.store);

    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const fake = fakeKaiten({ firstId: 960_000 });
    const run = await syncWithKaiten(ctx, fake.client);
    expect(run?.errors).toEqual([]);
    const card = [...fake.cards.values()].find((c) => c.title === 'Проверить файлы');
    const files = () => (card?.files ?? []).map((f) => [f.name, f.content.length]).sort();
    expect(files()).toEqual([
      ['DRAFT.md', Buffer.byteLength('# Черновик\n')],
      ['img/scheme.png', 7],
    ]);
    expect(git(remote, 'show', 'main:active/files.md')).toMatch(/files_hash: sha256:/);

    const recorded = recordOp(ctx.store, { kind: 'log', id: fm.id, text: 'Продолжил.' }, 'запись в журнал', '2026-09-29');
    if ('error' in recorded) throw new Error(recorded.error);
    fake.writes.length = 0;
    expect((await syncWithKaiten(ctx, fake.client))?.errors).toEqual([]);
    expect(files()).toHaveLength(2);
    expect(fake.writes.some((w) => w.includes('/files'))).toBe(false);
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
        project: {
          ...ctx.loaded.project,
          ignoreCards: [123],
          mapping: { ...ctx.loaded.project.mapping, columns: { inbox: 101, ready: 103, blocked: 105, cancelled: 108 }, priorityProperty: { id: 7, values: { p0: 70, p1: 71 } } },
        },
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

  it('приоритет — тем же запросом, остальные поля карточки не трогаем', async () => {
    const s = await setup(true);
    s.fake.cards.set(s.cardId, { ...s.fake.cards.get(s.cardId)!, properties: { id_2: [21] } });
    expect(await s.moveCardFirst(s.ctx, s.task, 'ready', s.fake.client, 'p0')).toBe('moved');
    expect(s.fake.cards.get(s.cardId)).toMatchObject({ column_id: 103, properties: { id_2: [21], id_7: [70] } });
  });

  it('карточка в архиве Kaiten: открытый статус достаёт её тем же запросом, закрытый — оставляет в архиве', async () => {
    const s = await setup(true);
    s.fake.cards.set(s.cardId, { ...s.fake.cards.get(s.cardId)!, archived: true });
    expect(await s.moveCardFirst(s.ctx, s.task, 'cancelled', s.fake.client)).toBe('moved');
    expect(s.fake.cards.get(s.cardId)).toMatchObject({ column_id: 108, archived: true });
    expect(await s.moveCardFirst(s.ctx, s.task, 'ready', s.fake.client)).toBe('moved');
    expect(s.fake.cards.get(s.cardId)).toMatchObject({ column_id: 103, archived: false });
    expect(s.fake.writes).toEqual([`PATCH /cards/${s.cardId}`, `PATCH /cards/${s.cardId}`]);
  });

  it('ограничение доски — команда останавливается словами владельца', async () => {
    const s = await setup(true);
    s.fake.failOn = () => ({ status: 400, body: { error_text: 'Из «В работе» — не в «Отменено»' } });
    await expect(s.moveCardFirst(s.ctx, s.task, 'cancelled', s.fake.client)).rejects.toThrow('Kaiten не разрешил — Из «В работе» — не в «Отменено»');
  });

  it('kaiten show: файлы карточки, которых нет в задаче; без связи — одна строка без подробностей', async () => {
    const s = await setup(true);
    const { foreignCardFiles } = await import('../kaiten-cli.js');
    const file = (name: string, size: number) => ({ id: `00000000-0000-4000-8000-${String(size).padStart(12, '0')}`, name, content: new Uint8Array(size) });
    s.fake.cards.set(s.cardId, { ...s.fake.cards.get(s.cardId)!, files: [file('ЖУРНАЛ.md', 10), file('draft.MD', 20), file('выгрузка.xlsx', 2048)] });
    expect(await foreignCardFiles(s.ctx, s.task, ['DRAFT.md'], s.fake.client)).toEqual({ files: [{ name: 'выгрузка.xlsx', size: 2048 }] });
    expect(s.fake.writes).toEqual([]);
    s.fake.failOn = () => ({ status: 500, body: {} });
    expect(await foreignCardFiles(s.ctx, s.task, [], s.fake.client)).toEqual({ unreachable: true });
    const noCard = { ...s.task, fm: { ...s.task.fm, tracker: undefined } };
    expect(await foreignCardFiles(s.ctx, noCard, [], s.fake.client)).toBeNull();
  });

  it('карточка из списка владельца — не трогаем', async () => {
    const s = await setup(true);
    const ignored = { ...s.task, fm: { ...s.task.fm, tracker: '123' } };
    expect(await s.moveCardFirst(s.ctx, ignored, 'cancelled', s.fake.client)).toBe('none');
    expect(s.fake.writes).toEqual([]);
  });
});
