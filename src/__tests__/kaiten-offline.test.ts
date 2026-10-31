/**
 * Kaiten недоступен: команды статуса не останавливаются, статус ждёт в задаче
 * (`pending_moves`), сверка его не откатывает, а карточка догоняет, когда Kaiten
 * вернулся. Отказ доски при этом остаётся отказом. Kaiten поддельный.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { contentHash, parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { pendingDecision, type CardView } from '../core/kaiten-sync-plan.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, tasksOf, type Op, type TaskTexts } from '../core/task-ops.js';
import type { Context } from '../kaiten-cli.js';
import { KaitenApiError, isOutage } from '../kaiten-client.js';
import { formatPlan, runKaitenSync } from '../kaiten-sync.js';
import { fakeKaiten, seedCard } from './fake-kaiten.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-offline-test-'));
// Путь настроек читается при загрузке модуля — задать до импорта.
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
writeFileSync(process.env.KAITEN_SETTINGS, JSON.stringify({ sync: { kaiten: true } }));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MAPPING: ConfigMapping = {
  boardId: 10,
  laneId: 20,
  columns: { inbox: 101, backlog: 102, ready: 103, 'in-progress': 104, blocked: 105, review: 106, done: 107, cancelled: 108 },
  priorityProperty: { id: 1, values: { p0: 11, p1: 12, p2: 13, p3: 14, pn: 15 } },
};
const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const CTX = { date: '2026-10-30', stamp: '2026-10-30 10:15:00 +03:00' };
const SINCE = '2026-10-30T07:00:00.000Z';
const PATH = 'active/offline.md';

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
      created: '2026-09-16',
      created_by: 'alice',
      updated: '2026-09-16',
      ...fm,
    }),
    '\nТекст.\n',
  );
}

const fmOf = (text: string | null | undefined): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);

function apply(texts: Map<string, string>, op: Op): void {
  const r = applyOp(op, texts as TaskTexts, CTX);
  if ('error' in r) throw new Error(r.error);
  for (const c of r.changes) {
    if (c.text === null) texts.delete(c.path);
    else texts.set(c.path, c.text);
  }
}

const card = (over: Partial<CardView> = {}): CardView => ({ id: 600, columnId: 104, properties: {}, parents: [], archived: false, ...over }) as CardView;
const pendingTask = (steps: Array<{ status: Frontmatter['status'] }>, from: Frontmatter['status'] = 'in-progress') =>
  tasksOf(new Map([[PATH, file({ status: steps[steps.length - 1].status, pending_moves: { since: SINCE, from, steps } })]]))[0];

describe('очередь в задаче', () => {
  it('статус меняется сразу, шаг ложится в очередь, следующий — в её хвост', () => {
    const texts = new Map([[PATH, file()]]);
    apply(texts, { kind: 'move', id: ID, status: 'review', queued: { at: SINCE, steps: [{ status: 'review' }] } });
    const first = fmOf(texts.get(PATH));
    expect(first.status).toBe('review');
    expect(first.pending_moves).toEqual({ since: SINCE, from: 'in-progress', steps: [{ status: 'review' }] });

    apply(texts, { kind: 'move', id: ID, status: 'done', queued: { at: '2026-10-30T08:00:00.000Z', steps: [{ status: 'done' }] } });
    const archived = [...texts.keys()].find((p) => p.startsWith('archive/') && p.endsWith('offline.md'));
    const second = fmOf(texts.get(archived ?? ''));
    expect(second.status).toBe('done');
    expect(second.pending_moves).toEqual({ since: SINCE, from: 'in-progress', steps: [{ status: 'review' }, { status: 'done' }] });
  });

  it('блокировка и отмена тоже встают в очередь', () => {
    const blocked = new Map([[PATH, file({ status: 'ready' })]]);
    apply(blocked, { kind: 'block', id: ID, reason: 'ждём доступ', queued: { at: SINCE, steps: [{ status: 'blocked' }] } });
    expect(fmOf(blocked.get(PATH)).pending_moves?.steps).toEqual([{ status: 'blocked' }]);

    const cancelled = new Map([[PATH, file({ status: 'inbox' })]]);
    apply(cancelled, { kind: 'cancel', id: ID, reason: 'не нужна', queued: { at: SINCE, steps: [{ status: 'cancelled' }] } });
    const path = [...cancelled.keys()].find((p) => p.startsWith('archive/') && p.endsWith('offline.md'));
    expect(fmOf(cancelled.get(path ?? '')).pending_moves?.from).toBe('inbox');
  });

  it('без очереди поле не появляется', () => {
    const texts = new Map([[PATH, file()]]);
    apply(texts, { kind: 'move', id: ID, status: 'review' });
    expect(fmOf(texts.get(PATH)).pending_moves).toBeUndefined();
  });

  it('снятие: дошедшие шаги уходят, дописанный за это время остаётся', () => {
    const texts = new Map([[PATH, file({ status: 'blocked', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }, { status: 'blocked' }] } })]]);
    apply(texts, { kind: 'mirror', items: [{ id: ID, settled: 1 }] });
    expect(fmOf(texts.get(PATH)).pending_moves).toEqual({ since: SINCE, from: 'review', steps: [{ status: 'blocked' }] });
    apply(texts, { kind: 'mirror', items: [{ id: ID, settled: 1 }] });
    expect(fmOf(texts.get(PATH)).pending_moves).toBeUndefined();
  });

  it('поле текста не меняет: описание карточки заново не отправляется', () => {
    const before = tasksOf(new Map([[PATH, file()]]))[0];
    const after = pendingTask([{ status: 'in-progress' }]);
    expect(contentHash(after.fm, after.body)).toBe(contentHash(before.fm, before.body));
  });
});

describe('что делать с очередью', () => {
  const task = pendingTask([{ status: 'review' }, { status: 'done' }]);

  it('карточка на месте — очередь снять', () => {
    expect(pendingDecision(task, card({ columnId: 107 }), MAPPING)).toEqual({ kind: 'settled' });
  });

  it('карточка не трогалась — все шаги', () => {
    const decision = pendingDecision(task, card({ columnId: 104 }), MAPPING);
    expect(decision.kind === 'replay' && decision.steps.map((s) => s.status)).toEqual(['review', 'done']);
  });

  it('обрыв на середине — только оставшиеся', () => {
    const decision = pendingDecision(task, card({ columnId: 106, columnChangedAt: '2026-10-30T09:00:00.000Z' }), MAPPING);
    expect(decision.kind === 'replay' && decision.steps.map((s) => s.status)).toEqual(['done']);
  });

  it('человек передвинул карточку позже — побеждает он', () => {
    expect(pendingDecision(task, card({ columnId: 105, columnChangedAt: '2026-10-30T09:00:00.000Z' }), MAPPING)).toEqual({ kind: 'human', status: 'blocked' });
  });

  it('перенос раньше смены статуса — не решение человека', () => {
    const decision = pendingDecision(task, card({ columnId: 105, columnChangedAt: '2026-10-29T09:00:00.000Z' }), MAPPING);
    expect(decision.kind).toBe('replay');
  });

  it('открытый статус достаёт карточку из архива, закрытый — нет', () => {
    const decision = pendingDecision(task, card(), MAPPING);
    expect(decision.kind === 'replay' && decision.steps.map((s) => s.reopen)).toEqual([true, false]);
  });
});

describe('сверка: Kaiten вернулся', () => {
  const texts = (fm: Partial<Frontmatter>): Map<string, string> => new Map([[PATH, file(fm)]]);
  const input = (t: Map<string, string>) => ({ tasks: tasksOf(t), mapping: MAPPING, boardId: 10, date: '2026-10-30', ignore: [], repoWebBase: null });

  it('карточка проходит шаги по порядку, очередь снимается, второй проход пуст', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 104, external_id: ID });
    const t = texts({ status: 'review', pending_moves: { since: SINCE, from: 'ready', steps: [{ status: 'in-progress' }, { status: 'review' }] } });
    fake.cards.get(600)!.column_id = 103;

    const run = await runKaitenSync(fake.client, input(t), 'apply');
    expect(run.errors).toEqual([]);
    expect(fake.writes.filter((w) => w === 'PATCH /cards/600').length).toBeGreaterThanOrEqual(2);
    expect(fake.cards.get(600)?.column_id).toBe(106);
    for (const { op } of run.ops) apply(t, op);
    expect(fmOf(t.get(PATH)).pending_moves).toBeUndefined();
    expect(fmOf(t.get(PATH)).status).toBe('review');

    const second = await runKaitenSync(fake.client, input(t), 'plan');
    expect(second.plan.actions.filter((a) => a.kind === 'replay')).toEqual([]);
    expect(second.plan.mirror.filter((m) => m.status !== undefined)).toEqual([]);
  });

  it('пока карточка догоняет, статус и приоритет файла не откатываются', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 104, external_id: ID });
    const t = texts({ status: 'review', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }] } });
    const { plan } = await runKaitenSync(fake.client, input(t), 'plan');
    expect(plan.mirror).toEqual([]);
    expect(plan.actions.map((a) => a.kind)).toContain('replay');
    expect(formatPlan({ plan, checklists: new Map() }).join('\n')).toContain('карточка → review');
  });

  it('приоритет `start --assigned` уходит тем же запросом', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 101, external_id: ID });
    const t = texts({ status: 'in-progress', priority: 'p0', pending_moves: { since: SINCE, from: 'inbox', steps: [{ status: 'ready', priority: 'p0' }, { status: 'in-progress' }] } });
    await runKaitenSync(fake.client, input(t), 'apply');
    expect(fake.cards.get(600)?.properties.id_1).toEqual([11]);
    expect(fake.cards.get(600)?.column_id).toBe(104);
  });

  it('отказ доски: статус возвращается к принятому, причина — в журнале и в сообщении', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 104, external_id: ID });
    let moves = 0;
    fake.failOn = (method, path) => {
      if (method !== 'PATCH' || path !== '/cards/600') return null;
      moves += 1;
      return moves === 2 ? { status: 400, body: { error_text: 'Нельзя закрыть без ревьюера' } } : null;
    };
    const t = new Map([[`archive/2026-10/offline.md`, file({ status: 'done', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }, { status: 'done' }] } })]]);
    const run = await runKaitenSync(fake.client, input(t), 'apply');
    expect(run.errors.map((e) => e.message).join()).toContain('Нельзя закрыть без ревьюера');
    for (const { op } of run.ops) apply(t, op);
    const fm = fmOf(t.get(PATH));
    expect(fm.status).toBe('review');
    expect(fm.pending_moves).toBeUndefined();
    expect(t.get('active/offline.log.md') ?? [...t.entries()].find(([p]) => p !== PATH)?.[1]).toContain('Нельзя закрыть без ревьюера');
  });

  it('сбой посреди догона: очередь остаётся, следующий проход продолжит', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 104, external_id: ID });
    let moves = 0;
    fake.failOn = (method, path) => {
      if (method !== 'PATCH' || path !== '/cards/600') return null;
      moves += 1;
      return moves === 2 ? { status: 503, body: {} } : null;
    };
    const t = texts({ status: 'done', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }, { status: 'done' }] } });
    const run = await runKaitenSync(fake.client, input(t), 'apply');
    expect(run.errors.length).toBe(1);
    expect(run.ops.filter(({ op }) => op.kind === 'mirror' && op.items.some((i) => i.settled !== undefined))).toEqual([]);
    expect(fake.cards.get(600)?.column_id).toBe(106);

    fake.failOn = undefined;
    fake.cards.get(600)!.column_changed_at = '2026-10-30T09:00:00.000Z';
    const next = await runKaitenSync(fake.client, input(t), 'apply');
    expect(fake.cards.get(600)?.column_id).toBe(107);
    expect(next.errors).toEqual([]);
  });

  it('человек передвинул карточку: статус из неё, очередь снята, команда скажет', async () => {
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 'Сделать задачу', board_id: 10, column_id: 105, external_id: ID, column_changed_at: '2026-10-30T09:00:00.000Z' });
    const t = texts({ status: 'review', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }] } });
    const run = await runKaitenSync(fake.client, input(t), 'apply');
    expect(fake.cards.get(600)?.column_id).toBe(105);
    expect(run.errors.map((e) => e.message).join()).toContain('передвинули');
    for (const { op } of run.ops) apply(t, op);
    expect(fmOf(t.get(PATH)).status).toBe('blocked');
    expect(fmOf(t.get(PATH)).pending_moves).toBeUndefined();
  });

  it('карточки больше нет: задача не ждёт вечно', async () => {
    const fake = fakeKaiten();
    const t = texts({ status: 'review', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }] } });
    const run = await runKaitenSync(fake.client, input(t), 'apply');
    for (const { op } of run.ops) apply(t, op);
    expect(fmOf(t.get(PATH)).pending_moves).toBeUndefined();
    expect(fmOf(t.get(PATH)).status).toBe('review');
  });
});

describe('команда статуса: сбой против отказа', () => {
  const store = join(tmp, 'store');
  const ctx = {
    store,
    loaded: { project: { mapping: MAPPING, ignoreCards: [] } },
  } as unknown as Context;
  const task = (fm: Partial<Frontmatter> = {}) => tasksOf(new Map([[PATH, file(fm)]]))[0];
  const down = { status: 503, body: {} };

  it('Kaiten не отвечает ни на что — шаг в очередь, карточка не тронута', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 't', board_id: 10, column_id: 104 });
    fake.failOn = () => down;
    const queue: Array<{ status: Frontmatter['status'] }> = [];
    await expect(moveCardFirst(ctx, task(), 'review', fake.client, undefined, queue)).resolves.toBe('queued');
    expect(queue).toEqual([{ status: 'review' }]);
    expect(fake.cards.get(600)?.column_id).toBe(104);
  });

  it('нет связи — тоже сбой', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    fake.failOn = () => {
      throw new TypeError('fetch failed');
    };
    await expect(moveCardFirst(ctx, task(), 'review', fake.client)).resolves.toBe('queued');
  });

  it('отказ доски — по-прежнему отказ', async () => {
    const { moveCardFirst, UsageError } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 't', board_id: 10, column_id: 104 });
    fake.failOn = (method) => (method === 'PATCH' ? { status: 400, body: { error_text: 'Сначала ревьюер' } } : null);
    const attempt = moveCardFirst(ctx, task(), 'review', fake.client);
    await expect(attempt).rejects.toBeInstanceOf(UsageError);
    await expect(attempt).rejects.toThrow('Сначала ревьюер');
  });

  it('5xx только на этот запрос, а Kaiten отвечает — это отказ, а не сбой', async () => {
    const { moveCardFirst, UsageError } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 't', board_id: 10, column_id: 104 });
    fake.failOn = (method) => (method === 'PATCH' ? { status: 500, body: { message: 'Internal Server Error' } } : null);
    await expect(moveCardFirst(ctx, task(), 'review', fake.client)).rejects.toBeInstanceOf(UsageError);
  });

  it('задача уже ждёт Kaiten — в очередь без запроса: шаги не перепрыгиваем', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 't', board_id: 10, column_id: 104 });
    const queue: Array<{ status: Frontmatter['status'] }> = [];
    const waiting = task({ status: 'review', pending_moves: { since: SINCE, from: 'in-progress', steps: [{ status: 'review' }] } });
    await expect(moveCardFirst(ctx, waiting, 'done', fake.client, undefined, queue)).resolves.toBe('queued');
    expect(fake.writes).toEqual([]);
    expect(queue).toEqual([{ status: 'done' }]);
  });

  it('второй шаг той же команды — в очередь, первый дошёл', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    seedCard(fake, { id: 600, title: 't', board_id: 10, column_id: 101 });
    const queue = [{ status: 'ready' as const }];
    await expect(moveCardFirst(ctx, task({ status: 'inbox' }), 'in-progress', fake.client, undefined, queue)).resolves.toBe('queued');
    expect(queue.map((s) => s.status)).toEqual(['ready', 'in-progress']);
  });

  it('что считается сбоем', () => {
    expect(isOutage(new KaitenApiError('сеть', 0, ''))).toBe(true);
    expect(isOutage(new KaitenApiError('работы', 503, ''))).toBe(true);
    expect(isOutage(new KaitenApiError('лимит', 429, ''))).toBe(true);
    expect(isOutage(new KaitenApiError('запрет', 403, ''))).toBe(false);
    expect(isOutage(new KaitenApiError('отказ доски', 400, ''))).toBe(false);
    expect(isOutage(new Error('другое'))).toBe(false);
  });
});
