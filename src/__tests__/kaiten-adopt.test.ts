/**
 * Kaiten → новый файл (этап 2c): карточка, заведённая в интерфейсе, становится
 * задачей. Первый проход — файл, комментарий с исходной постановкой и пометка
 * карточки; второй — описание из файла; третий — пусто.
 */
import { describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { adoptId, originalComment } from '../core/kaiten-adopt.js';
import { deriveId } from '../core/ulid.js';
import { Q41_NOTICE } from '../core/kaiten-sync-plan.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { kaitenTemplate } from '../core/skeleton.js';
import { applyOp, tasksOf } from '../core/task-ops.js';
import { formatPlan, runKaitenSync, type RunInput } from '../kaiten-sync.js';
import { fakeKaiten, seedCard, type FakeCard } from './fake-kaiten.js';

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
const PEOPLE = { 'alice@example.com': 'alice' };
const CREATED = '2026-09-20T21:30:00.000Z';

function uiCard(over: Partial<FakeCard> & { id: number }): Partial<FakeCard> & { id: number; title: string; board_id: number } {
  return {
    title: 'Починить вход по ссылке',
    board_id: BOARD,
    column_id: 101,
    type_id: 4,
    description: 'Ссылка из письма ведёт на 404.\n\n- проверить на проде',
    properties: { id_4: 'Вход по ссылке из письма не работает.', id_2: [21], id_1: [12], id_3: [31] },
    created: CREATED,
    owner: { email: 'Alice@Example.com', full_name: 'Алиса' },
    ...over,
  };
}

function fmOf(text: string | undefined): Frontmatter {
  return FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);
}

function world(entries: Array<[string, string]> = []) {
  const texts = new Map(entries);
  const fake = fakeKaiten({ requiredSummaryKey: 'id_4' });
  const input = (): RunInput => ({
    tasks: tasksOf(texts),
    mapping: MAPPING,
    ignore: [10000003],
    repoWebBase: null,
    defaultTeam: 'Разработка',
    boardId: BOARD,
    people: PEOPLE,
    date: '2026-09-29',
  });
  async function sync(extra: Partial<RunInput> = {}) {
    const run = await runKaitenSync(fake.client, { ...input(), ...extra }, 'apply');
    for (const { op } of run.ops) {
      const r = applyOp(op, texts, { date: '2026-09-29' });
      if ('error' in r) throw new Error(r.error);
      for (const c of r.changes) if (c.text === null) texts.delete(c.path);
      else texts.set(c.path, c.text);
    }
    return run;
  }
  return { texts, fake, sync, input };
}

describe('карточка из интерфейса', () => {
  it('сухой прогон: ничего не пишет и показывает будущий файл', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 700 }));
    const run = await runKaitenSync(w.fake.client, w.input(), 'details');
    expect(w.fake.writes).toEqual([]);
    const text = formatPlan(run).join('\n');
    expect(text).toContain('новых задач из карточек: 1');
    expect(text).toContain('→ файл: «Починить вход по ссылке» (700) (bug, inbox) → pochinit-vkhod-po-ssylke');
  });

  it('первый проход — файл, комментарий и пометка; описание не меняется', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 700 }));
    const run = await w.sync();
    expect(run.errors).toEqual([]);

    const id = adoptId(700, CREATED);
    const card = w.fake.cards.get(700);
    expect(card?.external_id).toBe(id);
    expect(card?.description).toBe('Ссылка из письма ведёт на 404.\n\n- проверить на проде');
    expect(card?.comments).toEqual([originalComment('Ссылка из письма ведёт на 404.\n\n- проверить на проде')]);

    const text = w.texts.get('active/pochinit-vkhod-po-ssylke.md');
    const fm = fmOf(text);
    expect(fm).toMatchObject({
      id,
      tracker: '700',
      title: 'Починить вход по ссылке',
      summary: 'Вход по ссылке из письма не работает.',
      type: 'bug',
      status: 'inbox',
      repo: 'acme-app',
      priority: 'p1',
      team: 'Разработка',
      // Дата создания — по местному времени, как все даты из Kaiten.
      created: new Date(CREATED).getDate() === 21 ? '2026-09-21' : '2026-09-20',
      created_by: 'alice',
      updated: '2026-09-29',
    });
    expect(fm.created_via).toBeUndefined();
    expect(fm.content_hash).toBeUndefined();
    expect(parseTaskDocument(text ?? '').body.trim()).toBe('Ссылка из письма ведёт на 404.\n\n- проверить на проде');
  });

  it('второй проход — описание из файла, чек-листы людей не тронуты; третий — пусто', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 700, checklists: [{ id: 1, name: 'Проверка', items: [{ id: 2, text: 'посмотреть', checked: true }] }] }));
    await w.sync();
    const second = await w.sync();
    expect(second.errors).toEqual([]);
    expect(second.adopt.candidates).toEqual([]);
    const card = w.fake.cards.get(700);
    expect(card?.description.startsWith(Q41_NOTICE)).toBe(true);
    expect(card?.description).toContain('Ссылка из письма ведёт на 404.');
    expect(card?.checklists).toEqual([{ id: 1, name: 'Проверка', items: [{ id: 2, text: 'посмотреть', checked: true }] }]);
    expect(card?.comments).toHaveLength(1);
    expect(fmOf(w.texts.get('active/pochinit-vkhod-po-ssylke.md')).content_hash).toBeDefined();

    const writes = w.fake.writes.length;
    const third = await w.sync();
    expect(third.plan.actions).toEqual([]);
    expect(third.ops).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
  });

  it('пустое описание — без комментария; закрытая карточка — в архив месяца закрытия', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 701, description: '', column_id: 107, column_changed_at: '2026-08-10T12:00:00.000Z' }));
    await w.sync();
    expect(w.fake.cards.get(701)?.comments).toEqual([]);
    expect(fmOf(w.texts.get('archive/2026-08/pochinit-vkhod-po-ssylke.md')).status).toBe('done');
  });

  it('незаполненный шаблон типа — не текст задачи: подсказки вырезаны, комментария нет', async () => {
    const w = world();
    // Как живьём 29.09: карточке без описания Kaiten подставляет шаблон типа.
    seedCard(w.fake, uiCard({ id: 705, description: kaitenTemplate('bug') }));
    seedCard(w.fake, uiCard({ id: 706, title: 'Добавить экспорт', description: kaitenTemplate('bug').replace('Ожидаемое поведение.', 'Вход с первого раза.') }));
    await w.sync();
    expect(w.fake.cards.get(705)?.comments).toEqual([]);
    const body = parseTaskDocument(w.texts.get('active/pochinit-vkhod-po-ssylke.md') ?? '').body;
    expect(body.trim()).toBe('## Что происходит\n\n## Как воспроизвести\n\n## Как должно быть\n\n## Критерии');
    expect(w.fake.cards.get(706)?.comments).toHaveLength(1);
    expect(parseTaskDocument(w.texts.get('active/dobavit-eksport.md') ?? '').body).toContain('## Как должно быть\n\nВход с первого раза.');
  });

  it('автор не из реестра людей — его имя в Kaiten', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 702, owner: { email: 'guest@example.com', full_name: 'Гость' } }));
    await w.sync();
    expect(fmOf(w.texts.get('active/pochinit-vkhod-po-ssylke.md')).created_by).toBe('Гость');
  });

  it('эпик и задача внутри него, заведённые руками, — задача ссылается на эпик', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 703, parents_ids: [704] }));
    seedCard(w.fake, uiCard({ id: 704, title: 'Сделать вход без пароля', type_id: 1, properties: { id_4: 'Вход без пароля.' } }));
    const run = await w.sync();
    expect(run.errors).toEqual([]);
    const all = tasksOf(w.texts);
    expect(all.find((t) => t.fm.tracker === '704')?.fm.type).toBe('epic');
    expect(all.find((t) => t.fm.tracker === '703')?.fm.epic).toBe('704');
    // Связь уже есть в Kaiten — второй проход её не дублирует.
    const second = await w.sync();
    expect(second.plan.actions.filter((a) => a.kind === 'link')).toEqual([]);
  });
});

describe('id задачи из карточки', () => {
  it('по дате создания в UTC — одинаковый в любом часовом поясе', () => {
    expect(adoptId(700, '2026-09-20T21:30:00.000Z')).toBe(deriveId('kaiten-card:700', '2026-09-20'));
    expect(adoptId(700, '2026-09-20T21:30:00.000Z')).not.toBe(adoptId(701, '2026-09-20T21:30:00.000Z'));
  });
});

describe('чего перенос не делает', () => {
  it('не трогает карточки с чужим ключом, архивные и из списка владельца', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 710, external_id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A' }));
    seedCard(w.fake, uiCard({ id: 711, archived: true }));
    seedCard(w.fake, uiCard({ id: 10000003 }));
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.adopt.candidates).toEqual([]);
    expect(run.adopt.foreign).toEqual(['«Починить вход по ссылке» (710): 01K5ZQ3R8F2K9M4N7P0T5V8W3A']);
    expect([...w.texts.keys()]).toEqual([]);
  });

  it('чего не хватает для файла — в отчёт словами карточки, в Kaiten ни одной записи', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 712, properties: {} }));
    seedCard(w.fake, uiCard({ id: 713, type_id: 999 }));
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.adopt.problems).toEqual([
      '«Починить вход по ссылке» (712): заполните «Суть»; выберите «Репозиторий»',
      '«Починить вход по ссылке» (713): тип карточки — не Epic/Story/Tech/Bug/Spike',
    ]);
    expect(formatPlan(run).join('\n')).toContain('поправьте в Kaiten');
  });

  it('описание не в markdown — ошибка карточки, без комментария и пометки', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 714, text_format_type_id: 2 }));
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.errors.map((e) => e.message)).toEqual(['описание карточки не в markdown — перенесите вручную']);
  });

  it('обрыв после пометки: следующий проход переносит заново, без второго комментария', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 715, external_id: adoptId(715, CREATED), comments: ['уже оставлен'] }));
    const run = await w.sync();
    expect(run.errors).toEqual([]);
    expect(w.fake.writes).toEqual([]);
    expect(w.fake.cards.get(715)?.comments).toEqual(['уже оставлен']);
    expect(fmOf(w.texts.get('active/pochinit-vkhod-po-ssylke.md')).tracker).toBe('715');
  });

  it('карточку пометил другой разработчик между чтением доски и переносом — без второго комментария', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 719 }));
    const plan = await runKaitenSync(w.fake.client, w.input(), 'plan');
    expect(plan.adopt.candidates).toHaveLength(1);
    const original = w.fake.client.getCard.bind(w.fake.client);
    w.fake.client.getCard = async (cardId: number) => {
      const card = w.fake.cards.get(cardId);
      if (card) card.external_id = adoptId(719, CREATED);
      return original(cardId);
    };
    const run = await w.sync();
    expect(run.errors).toEqual([]);
    expect(w.fake.writes).toEqual([]);
    expect(fmOf(w.texts.get('active/pochinit-vkhod-po-ssylke.md')).tracker).toBe('719');
  });

  it('одну карточку перенесли двое — одна задача', () => {
    const texts = new Map<string, string>();
    const fm = FrontmatterSchema.parse({
      id: adoptId(716, CREATED),
      tracker: '716',
      title: 'Починить вход',
      summary: 'Коротко.',
      type: 'bug',
      status: 'inbox',
      repo: 'acme-app',
      created: '2026-09-20',
      created_by: 'alice',
      updated: '2026-09-29',
    });
    const item = { slug: 'pochinit-vkhod', text: serializeTaskDocument(fm, '\nТекст.\n') };
    for (let i = 0; i < 2; i += 1) {
      const r = applyOp({ kind: 'adopt', items: [item] }, texts, { date: '2026-09-29' });
      if ('error' in r) throw new Error(r.error);
      for (const c of r.changes) if (c.text !== null) texts.set(c.path, c.text);
    }
    expect([...texts.keys()]).toEqual(['active/pochinit-vkhod.md']);
  });

  it('--only с номером карточки — только она; --only с задачей — ни одной карточки', async () => {
    const w = world();
    seedCard(w.fake, uiCard({ id: 717 }));
    seedCard(w.fake, uiCard({ id: 718, title: 'Добавить экспорт' }));
    const one = await runKaitenSync(w.fake.client, { ...w.input(), only: new Set(), onlyCards: new Set([718]) }, 'plan');
    expect(one.adopt.candidates.map((c) => c.card.id)).toEqual([718]);
    const none = await runKaitenSync(w.fake.client, { ...w.input(), only: new Set(['01K5ZQ3R8F2K9M4N7P0T5V8W3A']) }, 'plan');
    expect(none.adopt.candidates).toEqual([]);
  });
});
