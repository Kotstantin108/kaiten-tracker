/**
 * `kaiten rework`: вернуть задачу с ревью на доработку, не трогая репозиторий
 * кода — из чужого репозитория проекта, с чужой ветки и при незакоммиченных
 * изменениях. `kaiten start` на задаче из «Ревью» пишет в журнал то же начало
 * записи. Git локальный, Kaiten выключен.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { hasWorkNote } from '../core/task-ops.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-rework-test-'));
const app = join(tmp, 'app');
const store = join(tmp, 'store.git');
const saved = { cwd: process.cwd(), env: { ...process.env } };

// Пути настроек и конфига читаются при загрузке модулей — задать до импорта.
process.env.KAITEN_STORE = store;
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
process.env.KAITEN_CONFIG = join(tmp, 'kaiten.json');
process.env.KAITEN_SEND = 'off';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const BODY = '\n## Зачем\n\nНужно.\n\n## Что сделать\n\nСделать.\n\n## Критерии готовности\n\n- [x] Работает\n';
const ON_REVIEW = '## [2026-11-12 10:00:00 +03:00 · alice] в работе\n\n## [2026-11-12 10:30:00 +03:00 · alice] Сделал, проверил руками\n\n## [2026-11-12 11:00:00 +03:00 · alice] на ревью: PR #45\n';

function task(slug: string, fm: Partial<Frontmatter>): Array<[string, string]> {
  const text = serializeTaskDocument(
    FrontmatterSchema.parse({
      title: `Сделать ${slug}`,
      summary: 'Коротко.',
      type: 'story',
      status: 'review',
      repo: 'acme-app',
      created: '2026-11-01',
      created_by: 'alice',
      updated: '2026-11-01',
      ...fm,
    }),
    BODY,
  );
  return [
    [`active/${slug}.md`, text],
    [`active/${slug}.log.md`, ON_REVIEW],
  ];
}

const stored = (path: string): string => git(store, 'show', `main:${path}`);
const fmOf = (slug: string): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(stored(`active/${slug}.md`)).data);
const logOf = (slug: string): string => stored(`active/${slug}.log.md`);

async function refusal(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

beforeAll(() => {
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ sync: { kaiten: false }, person: 'bob' }));
  writeFileSync(
    join(tmp, 'kaiten.json'),
    JSON.stringify({
      project: 'acme',
      title: 'Acme',
      kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
      repos: [
        { name: 'acme-app', label: 'Acme-app' },
        { name: 'acme-site', label: 'Acme-site' },
      ],
      people: { people: { alice: { name: 'Алиса' }, bob: { name: 'Боб' } }, emails: {} },
    }),
  );
  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'active'), { recursive: true });
  const files = [
    // Задача другого репозитория проекта: ревьюер смотрит её не из него.
    ...task('site-form', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W4A', repo: 'acme-site', branch: 'feature/site-form' }),
    ...task('export', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W4B', branch: 'feature/export' }),
    ...task('going', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W4C', status: 'in-progress' }),
    ...task('waiting', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W4D', status: 'ready' }),
    ...task('big', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W4E', type: 'epic', repo: undefined }),
  ];
  for (const [path, text] of files) writeFileSync(join(seed, path), text);
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'посев');
  git(tmp, 'clone', '-q', '--bare', seed, 'store.git');

  mkdirSync(app);
  git(app, 'init', '-q');
  writeFileSync(join(app, '.kaiten'), 'tasks: https://example.com/acme/acme-tasks.git\nrepo: acme-app\n');
  writeFileSync(join(app, 'a.txt'), 'a\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'основа');
  git(app, 'switch', '-q', '-c', 'production');
  process.chdir(app);
});

afterAll(() => {
  process.chdir(saved.cwd);
  for (const k of ['KAITEN_STORE', 'KAITEN_SETTINGS', 'KAITEN_CONFIG', 'KAITEN_SEND']) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('kaiten rework', { timeout: 60_000 }, () => {
  it('возвращает задачу чужого репозитория, не трогая ветку и незакоммиченное', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    writeFileSync(join(app, 'a.txt'), 'правка не для коммита\n');
    writeFileSync(join(app, 'new.txt'), 'x\n');
    const branches = git(app, 'branch', '--format=%(refname:short)');
    await WRITE_COMMANDS.rework(['site-form', '--reason', 'проверка шла на устаревшей ветке']);
    expect(fmOf('site-form').status).toBe('in-progress');
    expect(fmOf('site-form').branch).toBe('feature/site-form');
    expect(logOf('site-form').trim().split('\n').at(-1)).toMatch(/· bob\] в работе: возвращена на доработку: проверка шла на устаревшей ветке$/);
    expect(git(app, 'branch', '--show-current')).toBe('production');
    expect(git(app, 'branch', '--format=%(refname:short)')).toBe(branches);
    expect(git(app, 'status', '--porcelain').split('\n').map((l) => l.trim())).toEqual(['M a.txt', '?? new.txt']);
    // Сдать заново можно только с новой записью о работе.
    expect(hasWorkNote(logOf('site-form'))).toBe(false);
    rmSync(join(app, 'new.txt'));
    git(app, 'checkout', '-q', '--', 'a.txt');
  });

  it('без замечаний, не из «Ревью» и для эпика — отказ, задача не меняется', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    expect(await refusal(() => WRITE_COMMANDS.rework(['export']))).toContain('--reason: что доработать');
    expect(await refusal(() => WRITE_COMMANDS.rework(['export', '--reason', '  ']))).toContain('--reason: что доработать');
    expect(await refusal(() => WRITE_COMMANDS.rework(['going', '--reason', 'нет теста']))).toContain('уже в работе. Замечания запишите в журнал: kaiten log going');
    expect(await refusal(() => WRITE_COMMANDS.rework(['waiting', '--reason', 'нет теста']))).toContain('в статусе ready: на доработку возвращают только из «Ревью»');
    expect(await refusal(() => WRITE_COMMANDS.rework(['big', '--reason', 'нет теста']))).toContain('эпик');
    expect(fmOf('export').status).toBe('review');
    expect(fmOf('going').status).toBe('in-progress');
    expect(fmOf('waiting').status).toBe('ready');
    expect(logOf('going')).toBe(ON_REVIEW.trim());
  });

  it('kaiten start на задаче из «Ревью» пишет в журнал, что она возвращена', async () => {
    const { START_COMMANDS } = await import('../kaiten-start.js');
    await START_COMMANDS.start(['export']);
    expect(fmOf('export').status).toBe('in-progress');
    expect(logOf('export').trim().split('\n').at(-1)).toMatch(/· bob\] в работе: возвращена на доработку$/);
    expect(git(app, 'branch', '--show-current')).toBe('feature/export');
    expect(hasWorkNote(logOf('export'))).toBe(false);
  });
});
