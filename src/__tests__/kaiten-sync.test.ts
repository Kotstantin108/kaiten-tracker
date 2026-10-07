/**
 * Синхронизация файл → Kaiten на поддельном Kaiten. Главный критерий, как у
 * пилота («без изменений 29 / 3»): второй прогон подряд — ни одной записи в
 * Kaiten и ни одной операции над файлами.
 */
import { describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { DESCRIPTION_LIMIT, linkify, Q41_NOTICE, repoWebBase } from '../core/kaiten-sync-plan.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, tasksOf } from '../core/task-ops.js';
import { formatPlan, runKaitenSync, type RunInput } from '../kaiten-sync.js';
import { fakeKaiten, seedCard } from './fake-kaiten.js';

const BOARD = 10;
const MAPPING: ConfigMapping = {
  boardId: BOARD,
  laneId: 20,
  columns: { inbox: 101, backlog: 102, ready: 103, 'in-progress': 104, blocked: 105, review: 106, done: 107, cancelled: 108 },
  types: { epic: 1, story: 2, tech: 3, bug: 4, spike: 5 },
  priorityProperty: { id: 1, values: { p0: 11, p1: 12, p2: 13, p3: 14, pn: 15 } },
  repoProperty: { id: 2, values: { 'acme-app': 21, 'acme-site': 22 } },
  teamProperty: { id: 3, values: { Разработка: 31, Менеджмент: 32 } },
  summaryProperty: { id: 4 },
};

let seq = 0;
function id(): string {
  seq += 1;
  return `01K5ZQ3R8F2K9M4N7P0T5V8W${String(seq).padStart(2, '0').replace(/[ILOU]/g, 'A')}`.slice(0, 26);
}

function task(path: string, fm: Partial<Frontmatter>, body = '## Критерии готовности\n\n- [x] Готово\n- [ ] Ещё\n'): [string, string] {
  const full = FrontmatterSchema.parse({
    id: id(),
    title: 'Сделать задачу',
    summary: 'Коротко для фаундера.',
    type: 'story',
    status: 'backlog',
    repo: 'acme-app',
    created: '2026-09-16',
    created_by: 'alice',
    updated: '2026-09-16',
    ...fm,
  });
  return [path, serializeTaskDocument(full, `\n${body}`)];
}

function world(entries: Array<[string, string]>) {
  const texts = new Map(entries);
  const fake = fakeKaiten({ requiredSummaryKey: 'id_4' });
  const input = (): RunInput => ({ tasks: tasksOf(texts), mapping: MAPPING, ignore: [10000002], repoWebBase: 'https://github.com/org/acme-tasks', defaultTeam: 'Разработка', boardId: BOARD });
  /** Прогон с записью; операции `synced` применяются к файлам, как это сделал бы журнал. */
  async function sync(extra: Partial<RunInput> = {}) {
    const run = await runKaitenSync(fake.client, { ...input(), ...extra }, 'apply');
    for (const { op } of run.ops) {
      const r = applyOp(op, texts, { date: '2026-09-28' });
      if ('error' in r) throw new Error(r.error);
      for (const c of r.changes) if (c.text === null) texts.delete(c.path);
      else texts.set(c.path, c.text);
    }
    return run;
  }
  return { texts, fake, sync, input };
}

describe('пилотная карточка', () => {
  it('первый прогон переписывает описание в новом виде, второй — ничего', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '500', title: 'Перенести пилот' });
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 500, title: 'Перенести пилот', board_id: BOARD, description: 'старое описание', properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });

    const first = await w.sync();
    expect(first.errors).toEqual([]);
    const card = w.fake.cards.get(500);
    expect(card?.description.startsWith(Q41_NOTICE)).toBe(true);
    expect(card?.checklists.map((l) => [l.name, l.items.map((i) => [i.text, i.checked])])).toEqual([
      ['Агент · Критерии готовности', [['Готово', true], ['Ещё', false]]],
    ]);
    expect(first.ops).toHaveLength(1);

    const writes = w.fake.writes.length;
    const second = await w.sync();
    expect(second.plan.actions).toEqual([]);
    expect(second.ops).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
  });

  it('правка заголовка в интерфейсе Kaiten возвращается к файлу, описание не трогается', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '501', title: 'Как в файле' });
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 501, title: 'Как в файле', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    await w.sync();
    const card = w.fake.cards.get(501);
    if (card) card.title = 'Поправили в Kaiten';
    w.fake.writes.length = 0;
    const run = await w.sync();
    expect(w.fake.writes).toEqual(['PATCH /cards/501']);
    expect(card?.title).toBe('Как в файле');
    expect(run.ops).toEqual([]);
  });

  it('отмеченный в файле пункт отмечается и в карточке', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '502' }, '## Критерии готовности\n\n- [ ] Ещё\n');
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 502, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    await w.sync();
    const [, current] = [...w.texts.entries()][0];
    w.texts.set(path, current.replace('- [ ] Ещё', '- [x] Ещё'));
    await w.sync();
    expect(w.fake.cards.get(502)?.checklists[0].items[0].checked).toBe(true);
    expect(w.fake.writes.some((x) => x.startsWith('PATCH /cards/502/checklists/'))).toBe(true);
  });
});

describe('пилот как он есть', () => {
  it('появился адрес репозитория задач — карточки перерисовываются, третий прогон пустой', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '510' }, 'Задача про [соседа](/active/pilot.md).\n\n## Критерии готовности\n\n- [ ] См. [соседа](/active/pilot.md)\n');
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 510, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    await w.sync({ repoWebBase: null });
    expect(w.fake.cards.get(510)?.checklists[0].items[0].text).toBe('См. соседа');
    await w.sync();
    expect(w.fake.cards.get(510)?.description).toContain('[соседа](https://github.com/org/acme-tasks/blob/main/active/pilot.md)');
    expect(w.fake.cards.get(510)?.checklists[0].items[0].text).toBe('См. [соседа](https://github.com/org/acme-tasks/blob/main/active/pilot.md)');
    expect(w.fake.cards.get(510)?.checklists[0].items).toHaveLength(1);
    const writes = w.fake.writes.length;
    await w.sync();
    expect(w.fake.writes.length).toBe(writes);
  });

  it('первая доставка: галочки Kaiten не снимаются, пункт с другой ссылкой не задваивается', async () => {
    const body = '## Критерии готовности\n\n- [x] Готово\n- [ ] Отмечено людьми в Kaiten\n- [ ] Отчёт в [RESEARCH](/attachments/pilot/R.md)\n- [ ] Новый пункт\n';
    const [path, text] = task('active/pilot.md', { tracker: '520' }, body);
    const w = world([[path, text]]);
    seedCard(w.fake, {
      id: 520,
      title: 'Сделать задачу',
      board_id: BOARD,
      properties: { id_4: 'Коротко для фаундера.', id_2: [21] },
      checklists: [
        {
          id: 1,
          name: 'Агент · Критерии готовности',
          items: [
            { id: 11, text: 'Готово', checked: false },
            { id: 12, text: 'Отмечено людьми в Kaiten', checked: true },
            { id: 13, text: 'Отчёт в [RESEARCH](tasks/.../R.md)', checked: false },
          ],
        },
      ],
    });
    const dry = await runKaitenSync(w.fake.client, w.input(), 'details');
    const line = formatPlan(dry).join('\n');
    expect(line).toContain('отметить 1');
    expect(line).toContain('отмечено в Kaiten, но не в файле — оставим 1');
    expect(line).toContain('добавить пунктов 1');
    expect(line).toContain('обновить текст пунктов 1');
    expect(line).not.toContain('СНЯТЬ');
    expect(w.fake.writes).toEqual([]);

    await w.sync();
    const items = w.fake.cards.get(520)?.checklists[0].items.map((i) => [i.text, i.checked]);
    expect(items).toEqual([
      ['Готово', true],
      ['Отмечено людьми в Kaiten', true],
      ['Отчёт в [RESEARCH](https://github.com/org/acme-tasks/blob/main/attachments/pilot/R.md)', false],
      ['Новый пункт', false],
    ]);
  });

  it('после первой доставки владелец пунктов — файл: снятая в файле галочка снимается', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '530' }, '## Критерии готовности\n\n- [x] Пункт\n');
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 530, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    await w.sync();
    const current = w.texts.get(path) ?? '';
    w.texts.set(path, current.replace('- [x] Пункт', '- [ ] Пункт'));
    await w.sync();
    expect(w.fake.cards.get(530)?.checklists[0].items[0].checked).toBe(false);
  });

  it('архивную карточку не трогаем', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '540' });
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 540, title: 'старое', board_id: BOARD, archived: true });
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.plan.report.archivedCards).toEqual(['pilot (540)']);
  });
});

describe('новые задачи', () => {
  it('задача из CLI получает карточку с «Сутью», колонкой и командой; ключ — в файл', async () => {
    const [path, text] = task('active/new.md', { status: 'inbox', created_via: 'agent' });
    const w = world([[path, text]]);
    await w.sync();
    const card = [...w.fake.cards.values()][0];
    expect(card).toMatchObject({ column_id: 101, lane_id: 20, type_id: 2, board_id: BOARD });
    expect(card.properties).toEqual({ id_4: 'Коротко для фаундера.', id_2: [21], id_3: [31] });
    expect(card.external_id).toMatch(/^01K5/);
    expect(w.texts.get(path)).toContain(`tracker: "${card.id}"`);
    const writes = w.fake.writes.length;
    // Второй проход пустой целиком: ни записей в Kaiten, ни коммитов (команда карточки уже в файле).
    const second = await w.sync();
    expect(second.plan.actions).toEqual([]);
    expect(second.ops).toEqual([]);
    expect(w.texts.get(path)).toContain('team: Разработка');
    expect(w.fake.writes.length).toBe(writes);
  });

  it('обрыв после создания: повтор находит карточку по id задачи, а не создаёт вторую', async () => {
    const [path, text] = task('active/new.md', { status: 'inbox', created_via: 'agent' });
    const w = world([[path, text]]);
    await runKaitenSync(w.fake.client, w.input(), 'apply'); // операции `synced` «потерялись»
    await w.sync();
    expect(w.fake.cards.size).toBe(1);
  });

  it('эпик и его задача в одном проходе: сначала эпик, потом связь', async () => {
    const [epicPath, epicText] = task('active/epic.md', { type: 'epic', repo: undefined, status: 'inbox', created_via: 'human' }, '## Цель\n\nРост.\n');
    const epicId = FrontmatterSchema.parse((await import('../core/document.js')).parseTaskDocument(epicText).data).id;
    const [childPath, childText] = task('active/child.md', { status: 'inbox', created_via: 'agent', epic: epicId });
    const w = world([
      [childPath, childText],
      [epicPath, epicText],
    ]);
    await w.sync();
    const epicCard = [...w.fake.cards.values()].find((c) => c.type_id === 1);
    const childCard = [...w.fake.cards.values()].find((c) => c.type_id === 2);
    expect(childCard?.parents_ids).toEqual([epicCard?.id]);
  });

  it('перенесённые задачи без карточки — только первой заливкой', async () => {
    const [p1, t1] = task('active/converted.md', {});
    const [p2, t2] = task('archive/2026-08/old-done.md', { status: 'done' });
    const [p3, t3] = task('archive/2026-05/older-done.md', { status: 'done' });
    const w = world([
      [p1, t1],
      [p2, t2],
      [p3, t3],
    ]);
    const auto = await w.sync();
    expect(auto.plan.report.firstLoadCandidates).toBe(1);
    expect(w.fake.writes).toEqual([]);
    expect(formatPlan(auto).join('\n')).toContain('--first-load');
    await w.sync({ firstLoad: { closedSince: '2026-07' } });
    expect([...w.fake.cards.values()].map((c) => c.title)).toHaveLength(2);
  });

  it('первая заливка: отменённые — только по отдельному флагу; --only — одна задача', async () => {
    const [p1, t1] = task('archive/2026-09/done.md', { status: 'done', title: 'Сделанная' });
    const [p2, t2] = task('archive/2026-09/cancelled.md', { status: 'cancelled', title: 'Отменённая' });
    const [p3, t3] = task('active/open.md', { title: 'Открытая' });
    const w = world([
      [p1, t1],
      [p2, t2],
      [p3, t3],
    ]);
    const plan = await runKaitenSync(w.fake.client, { ...w.input(), firstLoad: { closedSince: '2026-07' } }, 'plan');
    expect(plan.plan.actions.map((a) => a.task.slug).sort()).toEqual(['done', 'open']);
    const withCancelled = await runKaitenSync(w.fake.client, { ...w.input(), firstLoad: { closedSince: '2026-07', withCancelled: true } }, 'plan');
    expect(withCancelled.plan.actions).toHaveLength(3);
    const openId = tasksOf(w.texts).find((t) => t.slug === 'open')?.fm.id ?? '';
    const only = await runKaitenSync(w.fake.client, { ...w.input(), firstLoad: { closedSince: '2026-07' }, only: new Set([openId]) }, 'plan');
    expect(only.plan.actions.map((a) => a.task.slug)).toEqual(['open']);
  });
});

describe('чего синхронизация не делает', () => {
  it('не трогает карточки из списка владельца и не создаёт заново пропавшие', async () => {
    const [p1, t1] = task('archive/2026-09/v2.md', { tracker: '10000002', status: 'done' });
    const [p2, t2] = task('active/gone.md', { tracker: '777' });
    const w = world([
      [p1, t1],
      [p2, t2],
    ]);
    seedCard(w.fake, { id: 10000002, title: 'другой', board_id: BOARD });
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.plan.report.ignored).toEqual(['v2 (10000002)']);
    expect(run.plan.report.missingCards).toEqual(['gone (777)']);
  });

  it('ошибка одной задачи — словами Kaiten, остальные идут дальше; токена нет', async () => {
    const [p1, t1] = task('active/a.md', { status: 'inbox', created_via: 'agent', title: 'Первая задача' });
    const [p2, t2] = task('active/b.md', { status: 'inbox', created_via: 'agent', title: 'Вторая задача' });
    const w = world([
      [p1, t1],
      [p2, t2],
    ]);
    let failed = false;
    w.fake.failOn = (method, path) => {
      if (method === 'POST' && path === '/cards' && !failed) {
        failed = true;
        return { status: 400, body: { error_text: 'Из «Бэклога» — не в работу' } };
      }
      return null;
    };
    const run = await w.sync();
    expect(run.errors).toEqual([{ what: expect.stringContaining('создать карточку'), message: 'Из «Бэклога» — не в работу' }]);
    expect(w.fake.cards.size).toBe(1);
    expect(JSON.stringify(run)).not.toContain('secret-token');
  });
});

describe('ссылки в описании', () => {
  const [path, text] = task('archive/2026-09/old.md', { status: 'done' });
  const tasks = tasksOf(new Map([[path, text]]));

  it('на GitHub — постоянные, по текущему месту задачи; без адреса — просто текст', () => {
    const body = 'См. [старое](/active/old.md) и [отчёт](/attachments/old/R.md).';
    expect(linkify(body, tasks, 'https://github.com/org/acme-tasks')).toBe(
      'См. [старое](https://github.com/org/acme-tasks/blob/main/archive/2026-09/old.md) и [отчёт](https://github.com/org/acme-tasks/blob/main/attachments/old/R.md).',
    );
    expect(linkify(body, tasks, null)).toBe('См. старое и отчёт.');
  });

  it('адрес репозитория задач — из git-адреса', () => {
    expect(repoWebBase('git@github.com:org/acme-tasks.git')).toBe('https://github.com/org/acme-tasks');
    expect(repoWebBase('https://github.com/org/acme-tasks')).toBe('https://github.com/org/acme-tasks');
    expect(repoWebBase('C:/tmp/remote.git')).toBeNull();
  });
});

describe('длинное описание', () => {
  it('больше предела Kaiten — обрезается по абзацу со ссылкой на полный текст', async () => {
    const long = Array.from({ length: 800 }, (_, i) => `Абзац ${i}: ${'текст '.repeat(10)}`).join('\n\n');
    const [path, text] = task('active/long.md', { created_via: 'agent', status: 'inbox' }, `${long}\n`);
    const w = world([[path, text]]);
    const run = await w.sync();
    expect(run.errors).toEqual([]);
    const card = [...w.fake.cards.values()][0];
    expect(card.description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT + 300);
    expect(card.description).toContain('Полностью — [в репозитории задач](https://github.com/org/acme-tasks/blob/main/active/long.md)');
    expect(card.description).not.toMatch(/Абзац \d+: текст $/m);
  });
});

describe('дорожки: продукт и «Архив»', () => {
  const LANES: ConfigMapping = { ...MAPPING, repoLanes: { 'acme-app': 41, 'acme-site': 42 }, archiveLaneId: 49 };
  const NOW = Date.parse('2026-10-07T12:00:00.000Z');
  const DAYS_AGO = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

  function laneWorld(fm: Partial<Frontmatter>, card: { lane_id: number; column_id: number; column_changed_at?: string; repo?: number }) {
    const [path, text] = task('active/lane.md', { tracker: '600', ...fm });
    const w = world([[path, text]]);
    seedCard(w.fake, {
      id: 600,
      title: 'Сделать задачу',
      board_id: BOARD,
      lane_id: card.lane_id,
      column_id: card.column_id,
      ...(card.column_changed_at ? { column_changed_at: card.column_changed_at } : {}),
      properties: { id_4: 'Коротко для фаундера.', id_2: [card.repo ?? 21] },
    });
    return { w, lane: () => w.fake.cards.get(600)?.lane_id };
  }

  it('новая карточка — в дорожке своего продукта; эпик — в дорожке по умолчанию', async () => {
    const w = world([task('active/site.md', { repo: 'acme-site', created_via: 'human' }), task('active/epic.md', { type: 'epic', repo: undefined, created_via: 'human' })]);
    await w.sync({ mapping: LANES, now: NOW });
    const lanes = [...w.fake.cards.values()].map((c) => [c.title, c.lane_id]);
    expect(lanes).toEqual([
      ['Сделать задачу', 20],
      ['Сделать задачу', 42],
    ].sort((a, b) => Number(a[1]) - Number(b[1])));
  });

  it('закрыта больше месяца назад — в «Архив», поле «Репозиторий» остаётся', async () => {
    const { w, lane } = laneWorld({ status: 'done' }, { lane_id: 41, column_id: 107, column_changed_at: DAYS_AGO(31) });
    await w.sync({ mapping: LANES, now: NOW });
    expect(lane()).toBe(49);
    expect(w.fake.cards.get(600)?.properties.id_2).toEqual([21]);
  });

  it('закрыта недавно — остаётся в дорожке продукта', async () => {
    const { w, lane } = laneWorld({ status: 'cancelled' }, { lane_id: 41, column_id: 108, column_changed_at: DAYS_AGO(5) });
    await w.sync({ mapping: LANES, now: NOW });
    expect(lane()).toBe(41);
  });

  it('открыта снова, а лежит в «Архиве», — обратно в дорожку продукта', async () => {
    const { w, lane } = laneWorld({ status: 'in-progress' }, { lane_id: 49, column_id: 104, column_changed_at: DAYS_AGO(1) });
    await w.sync({ mapping: LANES, now: NOW });
    expect(lane()).toBe(41);
  });

  it('сменился продукт — новая дорожка; ручной перенос без смены продукта не откатываем', async () => {
    const moved = laneWorld({ repo: 'acme-site' }, { lane_id: 41, column_id: 102, repo: 21 });
    await moved.w.sync({ mapping: LANES, now: NOW });
    expect(moved.lane()).toBe(42);
    const manual = laneWorld({}, { lane_id: 42, column_id: 102 });
    await manual.w.sync({ mapping: LANES, now: NOW });
    expect(manual.lane()).toBe(42);
  });

  it('заведённая до дорожек (в дорожке по умолчанию) — в дорожку продукта; эпик с repo — остаётся', async () => {
    const { w, lane } = laneWorld({}, { lane_id: 20, column_id: 102 });
    await w.sync({ mapping: LANES, now: NOW });
    expect(lane()).toBe(41);
    const epic = laneWorld({ type: 'epic' }, { lane_id: 20, column_id: 107, column_changed_at: DAYS_AGO(2) });
    await epic.w.sync({ mapping: LANES, now: NOW });
    expect(epic.lane()).toBe(20);
  });

  it('без дорожек в маппинге — карточку не двигаем', async () => {
    const { w, lane } = laneWorld({ status: 'done' }, { lane_id: 20, column_id: 107, column_changed_at: DAYS_AGO(90) });
    await w.sync({ now: NOW });
    expect(lane()).toBe(20);
  });
});
