/**
 * Самообновление kaiten и версия синхронизации: папка инструмента — локальный
 * клон локального «GitHub», задачи — локальное хранилище, Kaiten поддельный.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { LoadedProject, People } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema } from '../core/schema.js';
import { SYNC_VERSION } from '../core/sync-version.js';
import type { Context } from '../kaiten-cli.js';
import { canPublishVersion, ensureFresh, storedSyncVersion, updateTool } from '../self-update.js';
import { syncStore, takeNotices } from '../store-write.js';
import { cloneStore } from '../task-store.js';
import { fakeKaiten } from './fake-kaiten.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-self-update-test-'));
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

let counter = 0;

/** «GitHub» инструмента, папка kaiten (клон) и вторая копия, из которой выходят новые версии. */
function toolRepos(): { origin: string; tool: string; dev: string } {
  counter += 1;
  const origin = join(tmp, `tool-${counter}.git`);
  git(tmp, 'init', '-q', '--bare', origin);
  const dev = join(tmp, `tool-dev-${counter}`);
  git(tmp, 'clone', '-q', origin, dev);
  writeFileSync(join(dev, 'package.json'), '{ "name": "kaiten-tracker" }\n');
  writeFileSync(join(dev, 'code.ts'), 'export const v = 1;\n');
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'v1');
  git(dev, 'push', '-q', 'origin', 'main');
  const tool = join(tmp, `tool-${counter}`);
  git(tmp, 'clone', '-q', origin, tool);
  return { origin, tool, dev };
}

function release(dev: string, file: string, text: string): string {
  writeFileSync(join(dev, file), text);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', `правка ${file}`);
  git(dev, 'push', '-q', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('обновление папки kaiten', { timeout: 30_000 }, () => {
  it('уже свежая — без изменений; вышла новая версия — перемотка на неё', () => {
    const { tool, dev } = toolRepos();
    expect(updateTool(tool)).toEqual({ ok: true, changed: false });
    const head = release(dev, 'code.ts', 'export const v = 2;\n');
    expect(updateTool(tool)).toEqual({ ok: true, changed: true });
    expect(git(tool, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('autocrlf=true (Windows): файлы с CRLF в рабочей копии — не правки', () => {
    const { tool, dev } = toolRepos();
    git(tool, 'config', 'core.autocrlf', 'true');
    rmSync(join(tool, 'code.ts'));
    execFileSync('git', ['checkout', '--', 'code.ts'], { cwd: tool, stdio: 'ignore' });
    expect(readFileSync(join(tool, 'code.ts'), 'utf8')).toContain('\r\n');
    release(dev, 'code.ts', 'export const v = 2;\n');
    expect(updateTool(tool)).toEqual({ ok: true, changed: true });
    expect(canPublishVersion(tool)).toBe(true);
  });

  it('свои правки, другая ветка, свои коммиты — не трогаем', () => {
    const dirty = toolRepos();
    release(dirty.dev, 'code.ts', 'export const v = 2;\n');
    writeFileSync(join(dirty.tool, 'code.ts'), 'export const v = 42;\n');
    expect(updateTool(dirty.tool)).toMatchObject({ ok: false, reason: expect.stringContaining('правки') });

    const branch = toolRepos();
    git(branch.tool, 'checkout', '-q', '-b', 'feature/x');
    expect(updateTool(branch.tool)).toMatchObject({ ok: false, reason: expect.stringContaining('не на ветке main') });

    const ahead = toolRepos();
    release(ahead.dev, 'code.ts', 'export const v = 2;\n');
    writeFileSync(join(ahead.tool, 'local.ts'), 'export {};\n');
    git(ahead.tool, 'add', '-A');
    git(ahead.tool, 'commit', '-q', '-m', 'своё');
    expect(updateTool(ahead.tool)).toMatchObject({ ok: false, reason: expect.stringContaining('свои коммиты') });
  });

  it('новой версии нужны другие зависимости — не обновляемся наполовину', () => {
    const { tool, dev } = toolRepos();
    const before = git(tool, 'rev-parse', 'HEAD');
    release(dev, 'package.json', '{ "name": "kaiten-tracker", "dependencies": { "left-pad": "1.3.0" } }\n');
    expect(updateTool(tool)).toMatchObject({ ok: false, reason: expect.stringContaining('npm install') });
    expect(git(tool, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('нет папки или нет связи — причина без путей и текста git', () => {
    expect(updateTool(null)).toMatchObject({ ok: false });
    const { tool, origin } = toolRepos();
    rmSync(origin, { recursive: true, force: true });
    const result = updateTool(tool);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('не удалось получить новую версию') });
    if (!result.ok) expect(result.reason).not.toContain(tmp);
  });

  it('версию синхронизации пишет только выпущенный код: чистая main, уже отправленная', () => {
    const { tool } = toolRepos();
    expect(canPublishVersion(tool)).toBe(true);
    expect(canPublishVersion(null)).toBe(false);
    writeFileSync(join(tool, 'local.ts'), 'export {};\n');
    git(tool, 'add', '-A');
    git(tool, 'commit', '-q', '-m', 'не отправлено');
    expect(canPublishVersion(tool)).toBe(false);
    const branch = toolRepos();
    git(branch.tool, 'checkout', '-q', '-b', 'feature/x');
    expect(canPublishVersion(branch.tool)).toBe(false);
  });
});

describe('версия синхронизации в задачах', { timeout: 60_000 }, () => {
  let ctx: Context;
  let remote: string;
  let seed: string;
  const savedToolDir = process.env.KAITEN_TOOL_DIR;
  // Один Kaiten на все проходы: карточка, созданная первым, обновляется вторым.
  const kaiten = fakeKaiten({ requiredSummaryKey: 'id_4' });

  afterEach(() => {
    process.env.KAITEN_TOOL_DIR = savedToolDir;
  });

  beforeAll(() => {
    remote = join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', remote);
    seed = join(tmp, 'seed');
    git(tmp, 'clone', '-q', remote, seed);
    mkdirSync(join(seed, 'active'));
    const fm = FrontmatterSchema.parse({
      id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A',
      title: 'Проверить версию синхронизации',
      summary: 'Старый kaiten не пишет в карточки.',
      type: 'tech',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-10-20',
      created_by: 'alice',
      created_via: 'agent',
      updated: '2026-10-20',
    });
    writeFileSync(join(seed, 'active', 'version.md'), serializeTaskDocument(fm, '\n## Критерии готовности\n\n- [ ] Работает\n'));
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
    writeFileSync(settingsPath, JSON.stringify({ sync: { kaiten: true } }));
  });

  it('код не выпущен (ветка) — карточки пишет, версию в задачи не пишет', async () => {
    const { tool } = toolRepos();
    git(tool, 'checkout', '-q', '-b', 'feature/x');
    process.env.KAITEN_TOOL_DIR = tool;
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    expect((await syncWithKaiten(ctx, kaiten.client))?.done).toBe(1);
    expect(storedSyncVersion(ctx.store)).toBe(0);
  });

  it('выпущенный код — версия в общих задачах раньше отметок о карточках', async () => {
    process.env.KAITEN_TOOL_DIR = toolRepos().tool;
    // Задача поменялась — карточку есть за что обновить.
    git(seed, 'pull', '-q');
    const path = join(seed, 'active', 'version.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('- [ ] Работает', '- [ ] Работает\n- [ ] Проверено'));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'новый пункт');
    git(seed, 'push', '-q', 'origin', 'main');
    syncStore(ctx.store);
    const { syncWithKaiten } = await import('../kaiten-cli.js');
    expect((await syncWithKaiten(ctx, kaiten.client))?.done).toBe(1);
    expect(JSON.parse(git(tmp, '--git-dir', remote, 'show', 'main:kaiten-sync.json'))).toEqual({ version: SYNC_VERSION });
    const subjects = git(tmp, '--git-dir', remote, 'log', '--format=%s', '-2', 'main').split('\n');
    expect(subjects[1]).toBe(`kaiten: версия синхронизации ${SYNC_VERSION}`);
  });

  it('в задачах версия новее — в Kaiten ни запроса, причина — следующей команде; обновиться не на что — так и сказано', async () => {
    git(seed, 'pull', '-q');
    writeFileSync(join(seed, 'kaiten-sync.json'), `{ "version": ${SYNC_VERSION + 1} }\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'новая версия');
    git(seed, 'push', '-q', 'origin', 'main');
    syncStore(ctx.store);
    expect(storedSyncVersion(ctx.store)).toBe(SYNC_VERSION + 1);

    const { syncWithKaiten } = await import('../kaiten-cli.js');
    const writes = kaiten.writes.length;
    expect(await syncWithKaiten(ctx, kaiten.client)).toBeNull();
    expect(kaiten.writes).toHaveLength(writes);
    expect(takeNotices(ctx.store).kaiten.map((k) => k.reason).join()).toContain('устарел');

    // Папка kaiten свежая, а версии новее нет: обновление ничего не даст, перезапускать незачем.
    process.env.KAITEN_TOOL_DIR = toolRepos().tool;
    expect(ensureFresh(ctx.store)).toEqual({ state: 'updated' });
    process.env.KAITEN_UPDATED = '1';
    try {
      expect(ensureFresh(ctx.store)).toMatchObject({ state: 'outdated', reason: expect.stringContaining('сообщите владельцу') });
    } finally {
      delete process.env.KAITEN_UPDATED;
    }
  });
});
