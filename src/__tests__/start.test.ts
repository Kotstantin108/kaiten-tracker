/**
 * `kaiten start`: когда задачу можно взять в работу, как называется ветка,
 * и что делает git в репозитории кода (временная папка).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { branchName, startProblem } from '../core/start.js';
import { tasksOf } from '../core/task-ops.js';
import type { TaskRecord } from '../core/tasks-index.js';
import { switchToTaskBranch } from '../kaiten-start.js';

function task(fm: Partial<Frontmatter> = {}): TaskRecord {
  const text = serializeTaskDocument(
    FrontmatterSchema.parse({
      id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A',
      tracker: '71226133',
      title: 'Починить повтор вебхука после 503',
      summary: 'Коротко.',
      type: 'bug',
      status: 'ready',
      repo: 'acme-app',
      created: '2026-09-16',
      created_by: 'alice',
      updated: '2026-09-16',
      ...fm,
    }),
    '\nТекст.\n',
  );
  const [record] = tasksOf(new Map([[`active/povtor-vebkhuka-posle-503.md`, text]]));
  return record;
}

describe('имя ветки', () => {
  it('номер карточки и имя задачи без цифр — в ветке ровно одно число', () => {
    expect(branchName('71226133', 'povtor-vebkhuka-posle-503')).toBe('feature/71226133-povtor-vebkhuka-posle');
    expect(branchName('71226133', 'v2-migratsiya-b24')).toBe('feature/71226133-migratsiya');
    expect(branchName('71226133', '2026')).toBe('feature/71226133');
  });
});

describe('можно ли взять в работу', () => {
  it('из «Готово к работе» и «Заблокировано» — да; в работе и на ревью — продолжить', () => {
    for (const status of ['ready', 'blocked', 'in-progress', 'review'] as const) expect(startProblem(task({ status }), 'acme-app')).toBeNull();
  });

  it('что мешает — словами задачи', () => {
    expect(startProblem(task({ status: 'backlog' }), 'acme-app')).toContain('в работу берут из «Готово к работе»');
    expect(startProblem(task({ status: 'done' }), 'acme-app')).toBe('задача уже в «Сделано»');
    expect(startProblem(task(), 'acme-site')).toBe('задача для репозитория acme-app, а вы в acme-site');
    expect(startProblem(task({ tracker: undefined }), 'acme-app')).toContain('ещё нет карточки');
    expect(startProblem(task({ tracker: 'PRJ-123' }), 'acme-app')).toContain('без номера карточки');
    expect(startProblem(task({ type: 'epic', repo: undefined }), 'acme-app')).toBe('это эпик: в работу берут его задачи — kaiten list --epic 71226133');
  });
});

describe('ветка в репозитории кода', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kaiten-start-'));
    dirs.push(dir);
    const g = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-qm', 'init');
    return dir;
  }
  const current = (dir: string): string => execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();

  it('новая ветка от текущей; повтор — уже на ней; с другой ветки — переключает обратно', () => {
    const dir = repo();
    expect(switchToTaskBranch(dir, '700', 'feature/700-pochinit')).toEqual({ branch: 'feature/700-pochinit', how: 'created', from: 'main' });
    expect(current(dir)).toBe('feature/700-pochinit');
    expect(switchToTaskBranch(dir, '700', 'feature/700-pochinit')).toEqual({ branch: 'feature/700-pochinit', how: 'already', from: null });
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir });
    expect(switchToTaskBranch(dir, '700', 'feature/700-pochinit')).toEqual({ branch: 'feature/700-pochinit', how: 'switched', from: null });
  });

  it('заголовок задачи поменяли — ветка карточки находится по номеру, вторая не заводится', () => {
    const dir = repo();
    switchToTaskBranch(dir, '700', 'feature/700-staroe-imya');
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir });
    expect(switchToTaskBranch(dir, '700', 'feature/700-novoe-imya')).toMatchObject({ branch: 'feature/700-staroe-imya', how: 'switched' });
    // Ветка другой карточки с тем же началом номера — не её.
    execFileSync('git', ['branch', 'feature/7001-drugaya'], { cwd: dir });
    execFileSync('git', ['switch', '-q', 'main'], { cwd: dir });
    expect(switchToTaskBranch(dir, '700', 'feature/700-novoe-imya')).toMatchObject({ branch: 'feature/700-staroe-imya' });
  });

  it('не репозиторий git — понятная ошибка', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaiten-start-nogit-'));
    dirs.push(dir);
    expect(switchToTaskBranch(dir, '700', 'feature/700-x')).toEqual({ error: 'эта папка — не репозиторий git' });
  });
});
