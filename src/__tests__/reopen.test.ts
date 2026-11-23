/**
 * Проверка находок не трогает задачи, а отменённое пачкой можно найти по
 * записи журнала и вернуть во «Входящие» (12.11.2026: разбор «старых задач
 * агентов» отменил поставленную работу — story и tech с критериями).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { newFindingText, pendingFindings } from '../core/found.js';
import { findCancelled, lastCancellation, reopenNote } from '../core/reopen.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, tasksOf, type Op, type TaskTexts } from '../core/task-ops.js';

const CTX = { date: '2026-11-12', stamp: '2026-11-12 12:03:00 +03:00', by: 'alice' };
const REASON = 'не подтверждена как дефект проверкой находок';

function file(id: string, fm: Partial<Frontmatter> = {}, body = '\n## Зачем\n\nНужно.\n\n## Критерии готовности\n\n- [ ] Работает\n'): string {
  return serializeTaskDocument(
    FrontmatterSchema.parse({
      id,
      title: 'Сделать экспорт заказов',
      summary: 'Коротко.',
      type: 'story',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-11-06',
      created_by: 'alice',
      created_via: 'agent',
      updated: '2026-11-06',
      ...fm,
    }),
    body,
  );
}

const STORY = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const BUG = '01K5ZQ3R8F2K9M4N7P0T5V8W3B';
const OTHER = '01K5ZQ3R8F2K9M4N7P0T5V8W3C';
const NOTE = '01K5ZQ3R8F2K9M4N7P0T5V8W3D';

function apply(texts: Map<string, string>, op: Op): void {
  const r = applyOp(op, texts as TaskTexts, CTX);
  if ('error' in r) throw new Error(r.error);
  for (const c of r.changes) {
    if (c.text === null) texts.delete(c.path);
    else texts.set(c.path, c.text);
  }
}

const fmOf = (text: string | undefined): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);

function note(): string {
  const text = newFindingText({ id: NOTE, repo: 'acme-app', createdBy: 'alice', title: 'Дата в отчёте — месяц/день', where: 'src/header.ts:1', seen: 'месяц стоит перед днём' }, '2026-11-12');
  if (typeof text !== 'string') throw new Error(text.error);
  return text;
}

describe('проверка находок трогает только заметки kaiten found', () => {
  const texts = (): Map<string, string> =>
    new Map([
      ['active/add-export.md', file(STORY)],
      ['active/fix-date.md', file(BUG, { type: 'bug', title: 'Починить дату' }, '\n## Что происходит\n\nA\n\n## Критерии\n\n- [ ] B\n')],
      [`findings/${NOTE}.md`, note()],
    ]);

  it('под проверку идут только неисследованные заметки — задачи агентов не попадают, какого бы типа ни были', () => {
    const files = [...texts().entries()].map(([path, text]) => ({ path, text }));
    expect(pendingFindings(files).map((f) => f.fm.id)).toEqual([NOTE]);
    // Ни одной заметки — исследовать нечего, даже если во «Входящих» лежат задачи агентов без приоритета.
    expect(pendingFindings(files.filter((f) => !f.path.startsWith('findings/')))).toEqual([]);
  });

  it('вердикт «не дефект, а новая работа» пишется в заметку; задачи остаются во «Входящих»', () => {
    const t = texts();
    const before = [t.get('active/add-export.md'), t.get('active/fix-date.md')];
    apply(t, { kind: 'found-verdict', id: NOTE, state: 'rejected', reason: 'В заметке нет дефекта. Это постановка новой работы.' });
    expect([t.get('active/add-export.md'), t.get('active/fix-date.md')]).toEqual(before);
    expect(tasksOf(t).map((x) => x.fm.status)).toEqual(['inbox', 'inbox']);
    expect([...t.keys()].some((p) => p.startsWith('archive/'))).toBe(false);
    expect(t.get(`findings/${NOTE}.md`)).toContain('state: rejected');
    // Вердикта для задачи не существует: заметки с таким id нет — операция отклоняется.
    expect(applyOp({ kind: 'found-verdict', id: STORY, state: 'rejected', reason: 'не дефект' }, t as TaskTexts, CTX)).toEqual({ error: 'находки больше нет среди находок проекта' });
  });

  it('скрипт владельца: --legacy отклоняется до чтения задач', () => {
    const script = fileURLToPath(new URL('../found.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--import', 'tsx', script, '--legacy', '--tasks', 'https://example.com/acme/acme-tasks.git'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Разбора задач агентов (--legacy) больше нет');
    expect(r.stderr).toContain('только заметки kaiten found');
  });
});

describe('отменённое пачкой', () => {
  /** Три задачи: две отменены прогоном 12.11, третья — человеком раньше и по другой причине. */
  function cancelled(): Map<string, string> {
    const t = new Map([
      ['active/add-export.md', file(STORY, { tracker: '601', epic: '500' })],
      ['active/fix-date.md', file(BUG, { type: 'bug', title: 'Починить дату', tracker: '602' }, '\n## Что происходит\n\nA\n\n## Критерии\n\n- [ ] B\n')],
      ['active/old-idea.md', file(OTHER, { type: 'tech', title: 'Убрать старый модуль' })],
      ['active/add-export.log.md', '## [2026-11-06 10:00:00 +03:00 · alice] Обсудили постановку\n'],
    ]);
    apply(t, { kind: 'cancel', id: STORY, reason: `${REASON}. В заметке нет дефекта. Это постановка новой работы` });
    apply(t, { kind: 'cancel', id: BUG, reason: `${REASON}. В основной ветке уже исправлено` });
    const earlier = applyOp({ kind: 'cancel', id: OTHER, reason: 'дубль PRJ-1' }, t as TaskTexts, { date: '2026-10-30', stamp: '2026-10-30 09:00:00 +03:00', by: 'bob' });
    if ('error' in earlier) throw new Error(earlier.error);
    for (const c of earlier.changes) {
      if (c.text === null) t.delete(c.path);
      else t.set(c.path, c.text);
    }
    return t;
  }

  it('запись об отмене читается из журнала: дата, автор, причина; нет записи — отменяли не командой', () => {
    expect(lastCancellation('## [2026-11-12 12:03:00 +03:00 · alice] отменена: не нужна\nвторая строка причины\n')).toEqual({
      date: '2026-11-12',
      stamp: '2026-11-12 12:03:00 +03:00',
      by: 'alice',
      reason: 'не нужна\nвторая строка причины',
    });
    expect(lastCancellation('## [2026-09-28] отменена: дубль\n')?.by).toBeNull();
    expect(lastCancellation('## [2026-11-12 12:03:00 +03:00 · alice] в работе\n')).toBeNull();
    expect(lastCancellation(null)).toBeNull();
  });

  it('список — по тексту причины и по дням; задачи с другой причиной и открытые не попадают', () => {
    const tasks = tasksOf(cancelled());
    const picked = findCancelled(tasks, { text: REASON });
    expect(picked.map((c) => [c.task.slug, c.task.fm.type, c.date, c.by])).toEqual([
      ['add-export', 'story', '2026-11-12', 'alice'],
      ['fix-date', 'bug', '2026-11-12', 'alice'],
    ]);
    expect(picked[0].reason).toContain('Это постановка новой работы');
    expect(findCancelled(tasks, { text: 'НЕ ПОДТВЕРЖДЕНА  как дефект' }).length).toBe(2);
    expect(findCancelled(tasks, {}).length).toBe(3);
    expect(findCancelled(tasks, { since: '2026-11-12' }).length).toBe(2);
    expect(findCancelled(tasks, { until: '2026-11-11' }).map((c) => c.task.slug)).toEqual(['old-idea']);
    expect(findCancelled(tasks, { text: REASON, since: '2026-11-13' })).toEqual([]);
  });

  it('возврат: задача снова во «Входящих», в active/, с журналом и записью о возврате; прочее не тронуто', () => {
    const t = cancelled();
    expect(t.has('archive/2026-11/add-export.md')).toBe(true);
    apply(t, { kind: 'mirror', items: [{ id: STORY, status: 'inbox', settled: 'all', note: reopenNote(' отменена по ошибке: это поставленная работа ') }] });
    expect(t.has('archive/2026-11/add-export.md')).toBe(false);
    const fm = fmOf(t.get('active/add-export.md'));
    expect(fm.status).toBe('inbox');
    expect(fm.epic).toBe('500');
    expect(fm.tracker).toBe('601');
    const log = t.get('active/add-export.log.md') ?? '';
    expect(log).toContain('Обсудили постановку');
    expect(log).toContain('отменена: не подтверждена как дефект');
    expect(log.trim().split('\n').at(-1)).toBe('## [2026-11-12 12:03:00 +03:00 · alice] возвращена во «Входящие»: отменена по ошибке: это поставленная работа');
    // Возвращённая задача под отбор больше не попадает; вторая — на месте.
    expect(findCancelled(tasksOf(t), { text: REASON }).map((c) => c.task.slug)).toEqual(['fix-date']);
  });
});

describe('скрипт владельца pnpm run reopen', { timeout: 60_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'kaiten-reopen-test-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('без --apply — только список отменённого с причиной; без отбора — отказ', () => {
    mkdirSync(join(tmp, 'archive', '2026-11'), { recursive: true });
    mkdirSync(join(tmp, 'active'));
    writeFileSync(join(tmp, 'kaiten.json'), JSON.stringify({ project: 'acme', title: 'Acme', kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' }, repos: [{ name: 'acme-app', label: 'Acme-app' }] }));
    writeFileSync(join(tmp, 'archive', '2026-11', 'add-export.md'), file(STORY, { status: 'cancelled', tracker: '601' }));
    writeFileSync(join(tmp, 'archive', '2026-11', 'add-export.log.md'), `## [2026-11-12 12:03:00 +03:00 · alice] отменена: ${REASON}. Это постановка новой работы\n`);
    writeFileSync(join(tmp, 'active', 'fix-date.md'), file(BUG, { type: 'bug', title: 'Починить дату' }, '\n## Что происходит\n\nA\n\n## Критерии\n\n- [ ] B\n'));
    const script = fileURLToPath(new URL('../reopen.ts', import.meta.url));
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, '--tasks', tmp, ...args], { encoding: 'utf8' });

    const list = run('--log', REASON);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('отменённых задач под отбор — 1');
    expect(list.stdout).toContain('По типам: story — 1.');
    expect(list.stdout).toContain('601');
    expect(list.stdout).toContain('Сделать экспорт заказов');
    expect(list.stdout).toContain('завёл агент, создана 2026-11-06; отменена 2026-11-12 12:03:00 +03:00 · alice: не подтверждена как дефект');
    expect(list.stdout).toContain('Сухой прогон: ничего не записано.');

    expect(run().status).toBe(2);
    const open = run('--only', 'fix-date');
    expect(open.status).toBe(2);
    expect(open.stderr).toContain('она в статусе inbox, а не отменена');
    // Запись — только из хранилища задач: рабочую копию скрипт не правит.
    const apply = run('--log', REASON, '--apply', '--reason', 'ошибка');
    expect(apply.status).toBe(2);
    expect(apply.stderr).toContain('только из хранилища задач');
  });
});
