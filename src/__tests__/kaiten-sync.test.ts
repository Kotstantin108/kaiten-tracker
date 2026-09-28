/**
 * Синхронизация файл → Kaiten на поддельном Kaiten. Главный критерий, как у
 * пилота («без изменений 29 / 3»): второй прогон подряд — ни одной записи в
 * Kaiten и ни одной операции над файлами.
 */
import { describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { serializeTaskDocument } from '../core/document.js';
import { linkify, Q41_NOTICE, repoWebBase } from '../core/kaiten-sync-plan.js';
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
    const run = await runKaitenSync(fake.client, { ...input(), ...extra }, true);
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
    expect((await w.sync()).plan.actions).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
  });

  it('обрыв после создания: повтор находит карточку по id задачи, а не создаёт вторую', async () => {
    const [path, text] = task('active/new.md', { status: 'inbox', created_via: 'agent' });
    const w = world([[path, text]]);
    await runKaitenSync(w.fake.client, w.input(), true); // операции `synced` «потерялись»
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
    expect(formatPlan(auto.plan).join('\n')).toContain('--first-load');
    await w.sync({ firstLoad: { closedSince: '2026-07' } });
    expect([...w.fake.cards.values()].map((c) => c.title)).toHaveLength(2);
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
