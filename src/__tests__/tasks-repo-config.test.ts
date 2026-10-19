/**
 * Конфиг проекта в репозитории задач (`kaiten.json`): инструмент не знает ни
 * одного проекта, команда берёт всё о проекте из хранилища после `kaiten pull`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { juniorSetting, projectFromTasksRepo, storeNameOf } from '../config.js';

const CONFIG = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [{ name: 'acme-app', label: 'Acme-app' }],
  teams: ['Разработка'],
  defaultTeam: 'Разработка',
  people: { people: { alice: { name: 'Алиса' } }, emails: { 'Alice@Example.com': 'alice' } },
};

describe('kaiten.json', () => {
  it('файл → проект: ключ, команды, люди; хранилище — по адресу', () => {
    const loaded = projectFromTasksRepo(JSON.stringify(CONFIG), 'https://example.com/acme/acme-tasks.git');
    expect(loaded.key).toBe('acme');
    expect(loaded.project.title).toBe('Acme');
    expect(loaded.project.tasksRepo).toEqual({ name: 'acme-tasks', url: 'https://example.com/acme/acme-tasks.git' });
    expect(loaded.config.defaultTeam).toBe('Разработка');
    expect(loaded.config.projects.acme).toEqual(loaded.project);
    expect(loaded.people.people.alice).toEqual({ name: 'Алиса' });
  });

  it('ошибки — словами с именем поля', () => {
    expect(() => projectFromTasksRepo('{')).toThrow('kaiten.json не разбирается как JSON');
    expect(() => projectFromTasksRepo(JSON.stringify({ ...CONFIG, repos: [] }))).toThrow(/repos/);
    expect(() => projectFromTasksRepo(JSON.stringify({ ...CONFIG, project: 'Acme Inc' }))).toThrow(/ключ проекта/);
  });

  it('архив Kaiten — без дорожки «Архив»: ни имени, ни id в маппинге', () => {
    const archive = (kaiten: Record<string, unknown>, mapping?: Record<string, unknown>) =>
      JSON.stringify({ ...CONFIG, kaiten: { ...CONFIG.kaiten, archiveInKaiten: true, ...kaiten }, ...(mapping ? { mapping } : {}) });
    expect(projectFromTasksRepo(archive({})).project.kaiten.archiveInKaiten).toBe(true);
    expect(projectFromTasksRepo(JSON.stringify(CONFIG)).project.kaiten.archiveInKaiten).toBe(false);
    expect(() => projectFromTasksRepo(archive({ archiveLane: 'Архив' }))).toThrow(/kaiten\.archiveLane: вместе с archiveInKaiten/);
    expect(() => projectFromTasksRepo(archive({}, { boardId: 1, columns: {}, archiveLaneId: 9 }))).toThrow(/mapping\.archiveLaneId/);
  });

  it('«Можно младшему»: нет блока — выключен; блок без полей — ждёт setup; поля в маппинге — включён', () => {
    const load = (kaiten: Record<string, unknown>, mapping?: Record<string, unknown>) =>
      projectFromTasksRepo(JSON.stringify({ ...CONFIG, kaiten: { ...CONFIG.kaiten, ...kaiten }, ...(mapping ? { mapping } : {}) })).project;
    expect(juniorSetting(load({}))).toEqual({ state: 'off' });
    expect(juniorSetting(load({ junior: {} }))).toEqual({ state: 'needs-setup', maxAgeDays: 90 });
    const fields = { juniorProperty: { id: 7, values: { yes: 71, no: 72 } }, juniorMissingProperty: { id: 8 } };
    expect(juniorSetting(load({ junior: { maxAgeDays: 60 } }, { boardId: 1, columns: {}, ...fields }))).toEqual({
      state: 'on',
      maxAgeDays: 60,
      property: { id: 7, yes: 71, no: 72 },
      missingPropertyId: 8,
    });
    expect(juniorSetting(load({ junior: {} }, { boardId: 1, columns: {}, juniorProperty: { id: 7, values: { yes: 71 } }, juniorMissingProperty: { id: 8 } })).state).toBe('needs-setup');
    expect(juniorSetting(load({}, { boardId: 1, columns: {}, ...fields }))).toEqual({ state: 'off' });
    expect(() => load({ junior: { maxAgeDays: 0 } })).toThrow(/kaiten\.junior\.maxAgeDays/);
  });

  it('незнакомый ключ в kaiten — не ошибка: так новый ключ не ломает прежние версии', () => {
    expect(() => projectFromTasksRepo(JSON.stringify({ ...CONFIG, kaiten: { ...CONFIG.kaiten, futureKey: 1 } }))).not.toThrow();
  });

  it('имя хранилища — последняя часть адреса без .git', () => {
    expect(storeNameOf('https://example.com/acme/acme-tasks.git')).toBe('acme-tasks');
    expect(storeNameOf('git@example.com:acme/acme-tasks.git')).toBe('acme-tasks');
    expect(storeNameOf('C:\\remotes\\acme-tasks.git\\')).toBe('acme-tasks');
  });
});

describe('команда kaiten берёт проект из хранилища', { timeout: 30_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kaiten-repo-config-'));
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' });
  };
  const saved = { cwd: process.cwd(), store: process.env.KAITEN_STORE, config: process.env.KAITEN_CONFIG, settings: process.env.KAITEN_SETTINGS };

  beforeAll(() => {
    const seed = join(tmp, 'seed');
    mkdirSync(join(seed, 'active'), { recursive: true });
    writeFileSync(join(seed, 'kaiten.json'), JSON.stringify(CONFIG));
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'посев');
    git(tmp, 'clone', '-q', '--bare', seed, 'store.git');
    mkdirSync(join(tmp, 'app'));
    writeFileSync(join(tmp, 'app', '.kaiten'), 'tasks: https://example.com/acme/acme-tasks.git\nrepo: acme-app\n');
    process.env.KAITEN_STORE = join(tmp, 'store.git');
    delete process.env.KAITEN_CONFIG;
    // Путь настроек читается при загрузке модуля: без person, чтобы автор шёл по почте.
    process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
    process.chdir(join(tmp, 'app'));
  });

  afterAll(() => {
    process.chdir(saved.cwd);
    if (saved.store === undefined) delete process.env.KAITEN_STORE;
    else process.env.KAITEN_STORE = saved.store;
    if (saved.config !== undefined) process.env.KAITEN_CONFIG = saved.config;
    if (saved.settings === undefined) delete process.env.KAITEN_SETTINGS;
    else process.env.KAITEN_SETTINGS = saved.settings;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('проект, продукт и автор новых задач — из kaiten.json репозитория задач', async () => {
    const { currentPerson, resolveContext } = await import('../kaiten-cli.js');
    const ctx = resolveContext();
    expect(ctx.tasksUrl).toBe('https://example.com/acme/acme-tasks.git');
    expect(ctx.title).toBe('Acme');
    expect(ctx.loaded.project.repos.map((r) => r.name)).toEqual(['acme-app']);
    expect(peopleKey(currentPerson, ctx.loaded.people)).toBe('alice');
  });

  it('шаблон в отказе kaiten new: разделы продукта, БД и n8n — только в проекте с признаком «Можно младшему»', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    const refusal = async (type: string): Promise<string> => {
      try {
        await WRITE_COMMANDS.new(['Починить таймаут', '--type', type, '--slug', 'fix-timeout', '--summary', 'Оплата не подтверждается.']);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    expect(await refusal('story')).toContain('--stdin: задача заводится с постановкой');
    expect(await refusal('story')).not.toContain('## Изменения в БД');

    const seed = join(tmp, 'seed');
    writeFileSync(join(seed, 'kaiten.json'), JSON.stringify({ ...CONFIG, kaiten: { ...CONFIG.kaiten, junior: {} } }));
    git(seed, 'commit', '-qam', 'признак «Можно младшему»');
    git(seed, 'push', '-q', join(tmp, 'store.git'), 'main');
    const story = await refusal('story');
    expect(story).toContain('## Изменения в БД');
    expect(story).toContain('«Нет» — только проверив по коду');
    expect(story.indexOf('## Сценарии n8n')).toBeLessThan(story.indexOf('## Критерии готовности'));
    expect(await refusal('spike')).not.toContain('## Изменения в БД');
  });

  it('продукта нет в проекте — отказ с подсказкой', async () => {
    writeFileSync(join(tmp, 'app', '.kaiten'), 'tasks: https://example.com/acme/acme-tasks.git\nrepo: other\n');
    const { resolveContext } = await import('../kaiten-cli.js');
    expect(() => resolveContext().title).toThrow(/нет репозитория «other»/);
  });
});

/** Автор по почте git: подменяем почту окружением git. */
function peopleKey(currentPerson: (p: never) => string, people: unknown): string {
  const env = { ...process.env };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'user.email';
  process.env.GIT_CONFIG_VALUE_0 = 'alice@example.com';
  try {
    return currentPerson(people as never);
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
}
