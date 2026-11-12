/**
 * Фоновое исследование находки целиком: заметка в хранилище → снимок основной
 * ветки (а не рабочей папки агента) → ответ исследователя → задача в
 * «Находках». Исследователь поддельный, git локальный.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LoadedProject, People } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { findingPath, newFindingText, parseFinding, type FindingAnswer } from '../core/found.js';
import { FrontmatterSchema } from '../core/schema.js';
import type { Investigator } from '../found-investigate.js';
import type { Context } from '../kaiten-cli.js';
import { recordOp } from '../store-write.js';
import { cloneStore } from '../task-store.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-found-test-'));
// Путь настроек читается при загрузке модуля — задать до импорта.
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
process.env.KAITEN_SEND = 'off';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const NOTE_A = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const NOTE_B = '01K5ZQ3R8F2K9M4N7P0T5V8W3C';
const MAIN_LINE = 'export const header = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`;';
const BRANCH_LINE = 'export const header = (d: Date): string => brokenWorkInProgress(d);';

let ctx: Context;
let code: string;

function note(id: string, title: string): string {
  const text = newFindingText({ id, repo: 'acme-app', from: 'export-orders', createdBy: 'alice', title, where: 'src/header.ts:1', seen: 'месяц стоит перед днём' }, '2026-11-12');
  if (typeof text !== 'string') throw new Error(text.error);
  return text;
}

function stored(path: string): string | null {
  try {
    return git(ctx.store, 'show', `main:${path}`);
  } catch {
    return null;
  }
}

beforeAll(() => {
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ sync: { kaiten: false }, person: 'alice' }));
  const remote = join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', remote);
  const seed = join(tmp, 'seed');
  git(tmp, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, 'active'));
  const fm = FrontmatterSchema.parse({
    id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B',
    title: 'Выгрузить заказы в отчёт',
    summary: 'Отчёт по заказам за месяц.',
    type: 'story',
    status: 'in-progress',
    repo: 'acme-app',
    created: '2026-11-01',
    created_by: 'alice',
    updated: '2026-11-01',
  });
  writeFileSync(join(seed, 'active', 'export-orders.md'), serializeTaskDocument(fm, '\n## Критерии готовности\n\n- [ ] Дата в отчёте — день.месяц\n'));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');
  const store = join(tmp, 'store.git');
  cloneStore(remote, store);

  // Репозиторий кода: в main — дефект, а агент сидит на ветке задачи с недоделанной правкой.
  code = join(tmp, 'code');
  mkdirSync(join(code, 'src'), { recursive: true });
  git(code, 'init', '-q');
  writeFileSync(join(code, 'src', 'header.ts'), `${MAIN_LINE}\n`);
  git(code, 'add', '-A');
  git(code, 'commit', '-q', '-m', 'main');
  git(code, 'switch', '-q', '-c', 'feature/export-orders');
  writeFileSync(join(code, 'src', 'header.ts'), `${BRANCH_LINE}\n`);

  const loaded = {
    key: 'acme',
    project: {
      title: 'Acme',
      kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme', found: { model: 'claude-opus-5-5' } },
      repos: [{ name: 'acme-app', label: 'Acme-app', branch: 'main', layout: 'folders' }],
      ignoreCards: [],
      retireFields: [],
      mapping: { boardId: 10, columns: { found: 100, inbox: 101 } },
    },
    config: { teams: [], projects: {} },
    people: { people: {}, emails: {} },
  } as unknown as LoadedProject & { people: People };
  ctx = { loaded, title: 'Acme', tasksUrl: 'https://example.com/acme/acme-tasks.git', currentRepo: 'acme-app', store, workDir: code };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const confirmed = (quote: string): FindingAnswer => ({
  verdict: 'confirmed',
  reason: 'Заголовок выводит месяц перед днём, а критерий задачи требует день.месяц.',
  duplicate_of: '',
  title: 'Починить порядок даты в заголовке отчёта',
  slug: 'fix-header-date',
  summary: 'В заголовке отчёта месяц стоит перед днём.',
  what_happens: 'Заголовок отчёта показывает дату как месяц/день.',
  reproduce: '1. Сформировать отчёт 3 октября — в заголовке 10/3.',
  expected: 'День.месяц — так записано в критериях задачи выгрузки.',
  criteria: ['Дата в заголовке — день.месяц'],
  evidence: [
    { role: 'actual', path: 'code/src/header.ts', line: 1, quote, note: 'месяц выводится первым' },
    { role: 'expected', path: 'tasks/active/export-orders.md', line: 14, quote: '- [ ] Дата в отчёте — день.месяц', note: 'критерий задачи' },
  ],
});

describe('очередь исследований', { timeout: 60_000 }, () => {
  it('исследователь видит основную ветку и задачи; подтверждённая находка — задача в «Находках»', async () => {
    const { enqueueFinding, runFoundQueue } = await import('../kaiten-found.js');
    expect('error' in recordOp(ctx.store, { kind: 'found-note', id: NOTE_A, text: note(NOTE_A, 'Месяц перед днём в заголовке') }, 'находка', '2026-11-12')).toBe(false);
    enqueueFinding(ctx.store, { id: NOTE_A, workDir: code });

    const seen: { code?: string; tasks?: boolean; ownNote?: boolean; prompt?: string; cwd?: string } = {};
    const run: Investigator = async ({ cwd, prompt }) => {
      seen.cwd = cwd;
      seen.prompt = prompt;
      // Окончания строк — как у обычной рабочей копии на этой машине (autocrlf).
      seen.code = readFileSync(join(cwd, 'code', 'src', 'header.ts'), 'utf8').replace(/\r\n/g, '\n');
      seen.tasks = existsSync(join(cwd, 'tasks', 'active', 'export-orders.md'));
      seen.ownNote = existsSync(join(cwd, findingPath(NOTE_A)));
      return { answer: confirmed(MAIN_LINE) };
    };
    await runFoundQueue(ctx, run);

    // Снимок — из main, а не из рабочей папки на ветке задачи; рабочая папка не тронута.
    expect(seen.code).toBe(`${MAIN_LINE}\n`);
    expect(readFileSync(join(code, 'src', 'header.ts'), 'utf8')).toBe(`${BRANCH_LINE}\n`);
    expect(git(code, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/export-orders');
    expect([seen.tasks, seen.ownNote]).toEqual([true, false]);
    expect(seen.prompt).toContain('Что не так: Месяц перед днём в заголовке');
    // Снимок убран за собой.
    expect(existsSync(seen.cwd ?? '')).toBe(false);

    const task = stored('active/fix-header-date.md') ?? '';
    expect(task).toContain('status: found');
    expect(task).toContain('type: bug');
    expect(task).toContain('created_via: agent');
    expect(task).toContain('- `src/header.ts:1` — месяц выводится первым');
    const resolved = parseFinding(stored(findingPath(NOTE_A)) ?? '');
    expect('error' in resolved || [resolved.fm.state, resolved.fm.task]).toEqual(['confirmed', 'fix-header-date']);
  });

  it('доказательство из ветки задачи не сходится с основной — заметка «не подтверждена», задачи нет', async () => {
    const { enqueueFinding, runFoundQueue } = await import('../kaiten-found.js');
    recordOp(ctx.store, { kind: 'found-note', id: NOTE_B, text: note(NOTE_B, 'Заголовок зовёт несуществующую функцию') }, 'находка', '2026-11-12');
    enqueueFinding(ctx.store, { id: NOTE_B, workDir: code });
    await runFoundQueue(ctx, async () => ({ answer: { ...confirmed(BRANCH_LINE), slug: 'fix-broken-header' } }));

    expect(stored('active/fix-broken-header.md')).toBeNull();
    const resolved = parseFinding(stored(findingPath(NOTE_B)) ?? '');
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.fm.state).toBe('rejected');
    expect(resolved.reason).toContain('в основной ветке нет такой строки');
  });

  it('исследование не состоялось — заметка остаётся неисследованной и сама не повторяется', async () => {
    const { enqueueFinding, runFoundQueue } = await import('../kaiten-found.js');
    const id = '01K5ZQ3R8F2K9M4N7P0T5V8W3D';
    recordOp(ctx.store, { kind: 'found-note', id, text: note(id, 'Что-то ещё') }, 'находка', '2026-11-12');
    enqueueFinding(ctx.store, { id, workDir: code });
    let calls = 0;
    const failing: Investigator = async () => {
      calls += 1;
      return { error: 'агент не запустился' };
    };
    await runFoundQueue(ctx, failing);
    await runFoundQueue(ctx, failing);
    expect(calls).toBe(1);
    const still = parseFinding(stored(findingPath(id)) ?? '');
    expect('error' in still || still.fm.state).toBe('pending');
  });
});
