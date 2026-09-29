/**
 * Kaiten → файл (этап 2b): поля Kaiten приезжают в задачи, закрытая задача
 * уезжает в архив месяца закрытия, открытая снова — обратно; статусные
 * команды сначала двигают карточку.
 */
import { describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { localDate, mirrorFromCard, type CardView } from '../core/kaiten-sync-plan.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, tasksOf, type TaskTexts } from '../core/task-ops.js';
import { formatPlan, runKaitenSync, toCardView } from '../kaiten-sync.js';
import { fakeKaiten, seedCard } from './fake-kaiten.js';

const MAPPING: ConfigMapping = {
  boardId: 10,
  laneId: 20,
  columns: { inbox: 101, backlog: 102, ready: 103, 'in-progress': 104, blocked: 105, review: 106, done: 107, cancelled: 108 },
  types: { epic: 1, story: 2, tech: 3, bug: 4, spike: 5 },
  priorityProperty: { id: 1, values: { p0: 11, p1: 12, p2: 13, p3: 14, pn: 15 } },
  repoProperty: { id: 2, values: { 'acme-app': 21 } },
  teamProperty: { id: 3, values: { Разработка: 31, Менеджмент: 32 } },
  summaryProperty: { id: 4 },
};
const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const CTX = { date: '2026-09-29' };

function file(fm: Partial<Frontmatter> = {}): string {
  return serializeTaskDocument(
    FrontmatterSchema.parse({
      id: ID,
      tracker: '600',
      title: 'Сделать задачу',
      summary: 'Коротко.',
      type: 'story',
      status: 'in-progress',
      repo: 'acme-app',
      priority: 'p1',
      team: 'Разработка',
      created: '2026-09-16',
      created_by: 'alice',
      updated: '2026-09-16',
      ...fm,
    }),
    '\nТекст.\n',
  );
}

function fmOf(text: string | null | undefined): Frontmatter {
  return FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);
}

function apply(texts: Map<string, string>, op: Parameters<typeof applyOp>[0]): ReturnType<typeof applyOp> {
  const r = applyOp(op, texts as TaskTexts, CTX);
  if ('error' in r) throw new Error(r.error);
  for (const c of r.changes) if (c.text === null) texts.delete(c.path);
  else texts.set(c.path, c.text);
  return r;
}

const card = (over: Partial<CardView> = {}): CardView => ({
  id: 600,
  title: 'Сделать задачу',
  externalId: null,
  parents: [],
  properties: { id_1: [12], id_3: [31], id_4: 'Коротко.', id_2: [21] },
  archived: false,
  columnId: 104,
  typeId: 2,
  dueDate: null,
  ...over,
});

describe('что Kaiten знает иначе', () => {
  const [task] = tasksOf(new Map([['active/t.md', file()]]));

  it('совпадает — ничего', () => {
    expect(mirrorFromCard(task, card(), MAPPING)).toEqual({ item: null, unknownColumn: false });
  });

  it('колонка, тип, приоритет, команда, срок', () => {
    const { item } = mirrorFromCard(task, card({ columnId: 107, columnChangedAt: '2026-08-15T12:00:00Z', typeId: 4, properties: { id_1: [], id_3: [32] }, dueDate: '2026-10-05T12:00:00Z' }), MAPPING);
    expect(item).toEqual({ id: ID, status: 'done', closedMonth: '2026-08', type: 'bug', priority: null, team: 'Менеджмент', due: '2026-10-05' });
  });

  it('колонка не из конфига — статус не трогаем и сообщаем', () => {
    expect(mirrorFromCard(task, card({ columnId: 999 }), MAPPING)).toEqual({ item: null, unknownColumn: true });
  });
});

describe('поля Kaiten в файле', () => {
  it('закрыта в Kaiten — в архив месяца закрытия вместе с журналом; открыта снова — обратно', () => {
    const texts = new Map([
      ['active/t.md', file()],
      ['active/t.log.md', '## [2026-09-16] создана\n'],
    ]);
    apply(texts, { kind: 'mirror', items: [{ id: ID, status: 'done', closedMonth: '2026-08' }] });
    expect([...texts.keys()].sort()).toEqual(['archive/2026-08/t.log.md', 'archive/2026-08/t.md']);
    expect(fmOf(texts.get('archive/2026-08/t.md')).status).toBe('done');
    apply(texts, { kind: 'mirror', items: [{ id: ID, status: 'ready' }] });
    expect([...texts.keys()].sort()).toEqual(['active/t.log.md', 'active/t.md']);
  });

  it('пустое в Kaiten — пусто в файле; срок — в planning', () => {
    const texts = new Map([['active/t.md', file({ planning: { due: '2026-09-30' } })]]);
    apply(texts, { kind: 'mirror', items: [{ id: ID, priority: null, team: null, due: null }] });
    const fm = fmOf(texts.get('active/t.md'));
    expect([fm.priority, fm.team, fm.planning]).toEqual([undefined, undefined, undefined]);
    apply(texts, { kind: 'mirror', items: [{ id: ID, due: '2026-10-05' }] });
    expect(fmOf(texts.get('active/t.md')).planning).toEqual({ due: '2026-10-05' });
  });

  it('поле, с которым файл стал бы битым, — пропуск с подсказкой, остальные пишутся', () => {
    const other = file().replace(ID, '01K5ZQ3R8F2K9M4N7P0T5V8W3B').replace("tracker: \"600\"", 'tracker: "601"');
    const texts = new Map([
      ['active/t.md', file({ epic: '71007999' })],
      ['active/u.md', other],
    ]);
    const r = apply(texts, {
      kind: 'mirror',
      items: [
        { id: ID, type: 'epic' },
        { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B', priority: 'p0' },
      ],
    });
    expect('warnings' in r && r.warnings[0]).toContain('поля из Kaiten не записаны');
    expect(fmOf(texts.get('active/u.md')).priority).toBe('p0');
    expect(fmOf(texts.get('active/t.md')).type).toBe('story');
  });
});

describe('даты Kaiten', () => {
  it('дата без времени — как есть', () => {
    expect(localDate('2026-10-05')).toBe('2026-10-05');
  });
});

describe('сверка целиком', () => {
  it('задачу отменили при выключенной синхронизации — откат виден в сухом прогоне', async () => {
    const texts = new Map([['archive/2026-09/t.md', file({ status: 'cancelled' })]]);
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 102, type_id: 2, properties: { id_1: [12], id_3: [31], id_4: 'Коротко.', id_2: [21] } });
    const run = await runKaitenSync(fake.client, { tasks: tasksOf(texts), mapping: MAPPING, ignore: [], repoWebBase: null, boardId: 10 }, 'details');
    expect(formatPlan(run).join('\n')).toContain('← 600 (t): статус → backlog');
    expect(fake.writes).toEqual([]);
  });

  it('карточку закрыли в Kaiten — задача в архиве; второй прогон пустой', async () => {
    const texts = new Map([['active/t.md', file()]]);
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 107, type_id: 2, properties: { id_1: [12], id_3: [31], id_4: 'Коротко.', id_2: [21] } });
    const input = () => ({ tasks: tasksOf(texts), mapping: MAPPING, ignore: [], repoWebBase: null, boardId: 10 });
    const first = await runKaitenSync(fake.client, input(), 'apply');
    for (const { op } of first.ops) apply(texts, op);
    expect([...texts.keys()].some((p) => p.startsWith('archive/') && p.endsWith('/t.md'))).toBe(true);
    const second = await runKaitenSync(fake.client, input(), 'apply');
    expect(second.plan.mirror).toEqual([]);
    expect(second.ops.filter((o) => o.op.kind === 'mirror')).toEqual([]);
  });
});

describe('срок из Kaiten', () => {
  it('без времени — дата как есть в любом часовом поясе; со временем — по местному', () => {
    expect(toCardView({ id: 1, due_date: '2026-10-15T00:00:00.000Z', due_date_time_present: false }).dueDate).toBe('2026-10-15');
    expect(toCardView({ id: 1, due_date: '2026-10-15T00:00:00.000Z' }).dueDate).toBe('2026-10-15');
    expect(toCardView({ id: 1, due_date: '2026-10-15T20:30:00.000Z', due_date_time_present: true }).dueDate).toBe('2026-10-15T20:30:00.000Z');
    expect(toCardView({ id: 1, due_date: null }).dueDate).toBeNull();
  });
});
