/**
 * Задача, взятая в работу сразу после `kaiten new` (живьём 12.11.2026):
 * карточки ещё нет — её создаёт фоновая отправка по тому статусу, который
 * задача имела в момент её прохода, — а `start` уже сменил статус. Раньше первая
 * же сверка возвращала задаче колонку свежей карточки («Входящие») и снимала
 * приоритет. Теперь статус ждёт карточку в очереди задачи (`pending_moves`).
 * Kaiten поддельный.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { pendingDecision } from '../core/kaiten-sync-plan.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, hasWorkNote, moveProblem, tasksOf, type Op, type TaskTexts } from '../core/task-ops.js';
import type { Context, MoveStep } from '../kaiten-cli.js';
import { runKaitenSync } from '../kaiten-sync.js';
import { fakeKaiten } from './fake-kaiten.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-new-start-test-'));
// Путь настроек читается при загрузке модуля — задать до импорта.
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
const sync = (on: boolean): void => writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ sync: { kaiten: on } }));
sync(true);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const MAPPING: ConfigMapping = {
  boardId: 10,
  laneId: 20,
  columns: { inbox: 101, backlog: 102, ready: 103, 'in-progress': 104, blocked: 105, review: 106, done: 107, cancelled: 108 },
  priorityProperty: { id: 1, values: { p0: 11, p1: 12, p2: 13, p3: 14, pn: 15 } },
};
const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const PATH = 'active/fix-export.md';
const LOG = 'active/fix-export.log.md';
const CTX = { date: '2026-11-12', stamp: '2026-11-12 12:00:00 +03:00', by: 'alice' };
const ctx = { store: join(tmp, 'store'), loaded: { project: { mapping: MAPPING, ignoreCards: [] } } } as unknown as Context;

/** Задача сразу после `kaiten new --agent`: во «Входящих», без приоритета и без карточки. */
function fresh(fm: Partial<Frontmatter> = {}): Map<string, string> {
  const text = serializeTaskDocument(
    FrontmatterSchema.parse({
      id: ID,
      title: 'Починить выгрузку',
      summary: 'Коротко.',
      type: 'tech',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-11-12',
      created_by: 'alice',
      created_via: 'agent',
      updated: '2026-11-12',
      ...fm,
    }),
    '\n## Критерии готовности\n\n- [ ] Работает\n',
  );
  return new Map([[PATH, text]]);
}

const fmOf = (texts: Map<string, string>, path = PATH): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(texts.get(path) ?? '').data);
const taskOf = (texts: Map<string, string>) => tasksOf(texts)[0];

function apply(texts: Map<string, string>, op: Op): void {
  const r = applyOp(op, texts as TaskTexts, CTX);
  if ('error' in r) throw new Error(r.error);
  for (const c of r.changes) {
    if (c.text === null) texts.delete(c.path);
    else texts.set(c.path, c.text);
  }
}

const input = (texts: Map<string, string>) => ({ tasks: tasksOf(texts), mapping: MAPPING, boardId: 10, date: '2026-11-12', ignore: [], repoWebBase: null });

/** `kaiten start --assigned` на задаче из «Входящих»: два шага карточки и запись статуса — как в команде. */
async function start(texts: Map<string, string>): Promise<string> {
  const { moveCardFirst, queuedOf } = await import('../kaiten-cli.js');
  const queue: MoveStep[] = [];
  const fake = fakeKaiten();
  await moveCardFirst(ctx, taskOf(texts), 'ready', fake.client, 'p0', queue);
  const card = await moveCardFirst(ctx, taskOf(texts), 'in-progress', fake.client, undefined, queue);
  expect(fake.writes).toEqual([]);
  apply(texts, { kind: 'move', id: ID, status: 'in-progress', assigned: true, branch: 'feature/fix-export', ...queuedOf(queue, card) });
  return card;
}

describe('карточки ещё нет', () => {
  it('шаг статуса встаёт в очередь задачи — без запроса в Kaiten', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const fake = fakeKaiten();
    const queue: MoveStep[] = [];
    await expect(moveCardFirst(ctx, taskOf(fresh()), 'ready', fake.client, 'p0', queue)).resolves.toBe('awaits-card');
    await expect(moveCardFirst(ctx, taskOf(fresh()), 'in-progress', fake.client, undefined, queue)).resolves.toBe('awaits-card');
    expect(queue).toEqual([{ status: 'ready', priority: 'p0' }, { status: 'in-progress' }]);
    expect(fake.writes).toEqual([]);
  });

  it('ждать нечего: синхронизация выключена или задаче карточку заводит только первая заливка', async () => {
    const { moveCardFirst } = await import('../kaiten-cli.js');
    const queue: MoveStep[] = [];
    // Перенесённая задача без `created_via`: сама карточка у неё не появится.
    await expect(moveCardFirst(ctx, taskOf(fresh({ created_via: undefined })), 'ready', fakeKaiten().client, undefined, queue)).resolves.toBe('none');
    sync(false);
    await expect(moveCardFirst(ctx, taskOf(fresh()), 'ready', fakeKaiten().client, undefined, queue)).resolves.toBe('none');
    sync(true);
    expect(queue).toEqual([]);
  });

  it('в журнале задачи — без слов о недоступном Kaiten: он доступен, просто карточки ещё нет', async () => {
    const texts = fresh();
    expect(await start(texts)).toBe('awaits-card');
    expect(texts.get(LOG)).toBe('## [2026-11-12 12:00:00 +03:00 · alice] в работе (из «Входящих», по прямому поручению, приоритет p0)\n');
    expect(fmOf(texts).pending_moves?.steps).toEqual([{ status: 'ready', priority: 'p0' }, { status: 'in-progress' }]);
    expect(fmOf(texts).pending_moves?.from).toBe('inbox');
  });
});

describe('start сразу после new', () => {
  it('как было: без очереди первая же сверка возвращала задаче «Входящие» и снимала приоритет', async () => {
    const fake = fakeKaiten();
    const texts = fresh();
    // Фоновая отправка после `new` построила план, пока задача была во «Входящих».
    const first = await runKaitenSync(fake.client, input(texts), 'apply');
    // `start` до правки: карточки нет — статус только в файле, без очереди.
    apply(texts, { kind: 'move', id: ID, status: 'in-progress', assigned: true });
    for (const { op } of first.ops) apply(texts, op);
    expect(fmOf(texts).tracker).toBeDefined();
    const { plan } = await runKaitenSync(fake.client, input(texts), 'plan');
    expect(plan.mirror).toEqual([expect.objectContaining({ id: ID, status: 'inbox', priority: null })]);
  });

  it('карточку создали по старому статусу: сверка доводит её до «В работе», статус и приоритет задачи не откатываются', async () => {
    const fake = fakeKaiten();
    const texts = fresh();
    const first = await runKaitenSync(fake.client, input(texts), 'apply');
    const card = [...fake.cards.values()][0];
    expect(card.column_id).toBe(101);

    // Пока карточка создаётся, агент берёт задачу в работу, отмечает пункт и пишет в журнал.
    await start(texts);
    apply(texts, { kind: 'check', id: ID, items: ['Работает'], checked: true });
    apply(texts, { kind: 'log', id: ID, text: 'Починил выгрузку, проверил тестом' });
    // Отправка дописывает ключ карточки.
    for (const { op } of first.ops) apply(texts, op);
    expect(fmOf(texts).tracker).toBe(String(card.id));
    expect(fmOf(texts).status).toBe('in-progress');

    const second = await runKaitenSync(fake.client, input(texts), 'apply');
    expect(second.errors).toEqual([]);
    expect(second.plan.mirror.filter((m) => m.status !== undefined || m.priority !== undefined)).toEqual([]);
    expect(card.column_id).toBe(104);
    expect(card.properties.id_1).toEqual([11]);
    for (const { op } of second.ops) apply(texts, op);

    const fm = fmOf(texts);
    expect(fm.status).toBe('in-progress');
    expect(fm.priority).toBe('p0');
    expect(fm.pending_moves).toBeUndefined();
    // Запись журнала и отметка на месте — на ревью задача уходит без повторного `start` и `log`.
    expect(texts.get(LOG)).toContain('Починил выгрузку, проверил тестом');
    expect(hasWorkNote(texts.get(LOG) ?? null)).toBe(true);
    expect(texts.get(PATH)).toContain('- [x] Работает');
    expect(moveProblem(taskOf(texts), 'review')).toBeNull();

    const third = await runKaitenSync(fake.client, input(texts), 'plan');
    expect(third.plan.mirror).toEqual([]);
    expect(third.plan.actions.filter((a) => a.kind === 'replay')).toEqual([]);
  });

  it('карточка, созданная позже смены статуса и стоящая в прежней колонке, — не решение человека: её догоняют', async () => {
    const texts = fresh({ tracker: '600' });
    apply(texts, { kind: 'move', id: ID, status: 'in-progress', assigned: true, queued: { at: '2026-11-12T09:00:00.000Z', steps: [{ status: 'ready', priority: 'p0' }, { status: 'in-progress' }], silent: true } });
    const card = { id: 600, title: '', externalId: ID, parents: [], properties: {}, archived: false, columnId: 101, columnChangedAt: '2026-11-12T09:00:05.000Z' };
    const decision = pendingDecision(taskOf(texts), card, MAPPING);
    expect(decision.kind === 'replay' && decision.steps.map((s) => s.status)).toEqual(['ready', 'in-progress']);
  });

  it('карточку создают уже после start: сразу в «В работе» с приоритетом, очередь снимается тем же проходом', async () => {
    const fake = fakeKaiten();
    const texts = fresh();
    await start(texts);
    const run = await runKaitenSync(fake.client, input(texts), 'apply');
    const card = [...fake.cards.values()][0];
    expect(card.column_id).toBe(104);
    expect(card.properties.id_1).toEqual([11]);
    for (const { op } of run.ops) apply(texts, op);
    expect(fmOf(texts).tracker).toBe(String(card.id));
    expect(fmOf(texts).pending_moves).toBeUndefined();
    expect(fmOf(texts).status).toBe('in-progress');
    const next = await runKaitenSync(fake.client, input(texts), 'plan');
    expect(next.plan.mirror).toEqual([]);
    expect(next.plan.actions).toEqual([]);
  });

  it('задачу отменили раньше, чем появилась карточка: карточки не будет, и задача её не ждёт', async () => {
    const fake = fakeKaiten();
    const texts = fresh();
    apply(texts, { kind: 'cancel', id: ID, reason: 'дубль', queued: { at: '2026-11-12T09:00:00.000Z', steps: [{ status: 'cancelled' }], silent: true } });
    const archived = 'archive/2026-11/fix-export.md';
    expect(fmOf(texts, archived).pending_moves).toBeDefined();
    const run = await runKaitenSync(fake.client, input(texts), 'apply');
    expect(fake.cards.size).toBe(0);
    for (const { op } of run.ops) apply(texts, op);
    expect(fmOf(texts, archived).status).toBe('cancelled');
    expect(fmOf(texts, archived).pending_moves).toBeUndefined();
  });
});
