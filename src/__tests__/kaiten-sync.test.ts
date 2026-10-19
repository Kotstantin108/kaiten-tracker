/**
 * Синхронизация файл → Kaiten на поддельном Kaiten. Главный критерий, как у
 * пилота («без изменений 29 / 3»): второй прогон подряд — ни одной записи в
 * Kaiten и ни одной операции над файлами.
 */
import { describe, expect, it } from 'vitest';

import type { ConfigMapping } from '../config.js';
import { contentHash, serializeTaskDocument } from '../core/document.js';
import { DESCRIPTION_LIMIT, linkify, Q41_NOTICE, repoWebBase, type AttachmentRef } from '../core/kaiten-sync-plan.js';
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
      const r = applyOp(op, texts, { date: '2026-09-28', stamp: '2026-09-28 10:15:00 +03:00' });
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

  it('закрытая задача с карточкой в архиве — порядок: не трогаем и не докладываем', async () => {
    const [path, text] = task('archive/2026-09/shipped.md', { tracker: '541', status: 'done' });
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 541, title: 'старое', board_id: BOARD, archived: true });
    const run = await w.sync();
    expect(w.fake.writes).toEqual([]);
    expect(run.plan.report.archivedCards).toEqual([]);
  });
});

describe('чек-лист — как в файле', () => {
  const ordered = (w: ReturnType<typeof world>, cardId: number, name: string) =>
    [...(w.fake.cards.get(cardId)?.checklists.find((l) => l.name === name)?.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  /** Карточка уже получала содержимое; дальше правится только тело задачи. */
  async function delivered(cardId: number, body: string) {
    const [path, text] = task('active/edit.md', { tracker: String(cardId) }, body);
    const w = world([[path, text]]);
    seedCard(w.fake, { id: cardId, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    await w.sync();
    const edit = async (from: string, to: string) => {
      w.texts.set(path, (w.texts.get(path) ?? '').replace(from, to));
      return w.sync();
    };
    return { w, edit };
  }

  it('правка критериев: удалённые пункты уходят, изменённый — на месте, отметки неизменённых остаются', async () => {
    const { w, edit } = await delivered(600, '## Критерии готовности\n\n- [x] Первый\n- [ ] Второй\n- [ ] Третий\n- [ ] Четвёртый\n');
    const before = ordered(w, 600, 'Агент · Критерии готовности');
    const run = await edit('- [ ] Второй\n- [ ] Третий\n- [ ] Четвёртый\n', '- [ ] Второй, уточнённый\n');
    expect(run.errors).toEqual([]);
    const after = ordered(w, 600, 'Агент · Критерии готовности');
    expect(after.map((i) => [i.text, i.checked])).toEqual([
      ['Первый', true],
      ['Второй, уточнённый', false],
    ]);
    expect(after.map((i) => i.id)).toEqual([before[0].id, before[1].id]);

    const writes = w.fake.writes.length;
    await w.sync();
    expect(w.fake.writes.length).toBe(writes);
  });

  it('сухой прогон называет, что будет удалено; запись — только с apply', async () => {
    const { w } = await delivered(601, '## Критерии готовности\n\n- [ ] Оставить\n- [ ] Устаревший пункт\n');
    const path = [...w.texts.keys()][0];
    w.texts.set(path, (w.texts.get(path) ?? '').replace('- [ ] Устаревший пункт\n', ''));
    const writes = w.fake.writes.length;
    const dry = await runKaitenSync(w.fake.client, w.input(), 'details');
    expect(formatPlan(dry).join('\n')).toContain('УДАЛИТЬ пунктов 1: «Устаревший пункт»');
    expect(w.fake.writes.length).toBe(writes);
  });

  it('переименованный раздел: старый чек-лист «Агент · …» удаляется, чек-лист людей не трогаем', async () => {
    const { w, edit } = await delivered(602, '## Критерии готовности\n\n- [x] Пункт\n');
    w.fake.cards.get(602)?.checklists.push({ id: 77, name: 'Вопросы заказчика', items: [{ id: 78, text: 'Свой пункт', checked: false }] });
    await edit('## Критерии готовности', '## Критерии');
    const lists = w.fake.cards.get(602)?.checklists.map((l) => [l.name, l.items.map((i) => [i.text, i.checked])]);
    expect(lists).toEqual([
      ['Вопросы заказчика', [['Свой пункт', false]]],
      ['Агент · Критерии', [['Пункт', true]]],
    ]);
  });

  it('порядок — как в файле: вставленный в середину пункт встаёт на своё место', async () => {
    const { w, edit } = await delivered(603, '## Шаги\n\n- [ ] Раз\n- [ ] Три\n');
    await edit('- [ ] Раз\n', '- [ ] Раз\n- [ ] Два\n');
    expect(ordered(w, 603, 'Агент · Шаги').map((i) => i.text)).toEqual(['Раз', 'Два', 'Три']);
    await edit('- [ ] Раз\n- [ ] Два\n- [ ] Три\n', '- [ ] Три\n- [ ] Раз\n- [ ] Два\n');
    expect(ordered(w, 603, 'Агент · Шаги').map((i) => i.text)).toEqual(['Три', 'Раз', 'Два']);
    expect(w.fake.cards.get(603)?.checklists[0].items).toHaveLength(3);
  });

  it('--resend: карточка, доставленная прежними правилами, приводится к файлу; без расхождений — ни одной записи', async () => {
    const { w } = await delivered(605, '## Критерии готовности\n\n- [ ] Нужный\n');
    // Как у карточек до исправления: старые пункты остались рядом с новыми.
    w.fake.cards.get(605)?.checklists[0].items.push({ id: 6051, text: 'Устаревший', checked: false, sort_order: 2 });
    expect((await w.sync()).plan.actions).toEqual([]);
    await w.sync({ resend: true });
    expect(ordered(w, 605, 'Агент · Критерии готовности').map((i) => i.text)).toEqual(['Нужный']);

    const writes = w.fake.writes.length;
    const again = await w.sync({ resend: true });
    expect(again.errors).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
    expect(again.ops).toEqual([]);
  });

  it('первая доставка ничего не удаляет и не переписывает: лишнее — в отчёте', async () => {
    const [path, text] = task('active/pilot.md', { tracker: '604' }, '## Критерии готовности\n\n- [ ] Из файла\n');
    const w = world([[path, text]]);
    seedCard(w.fake, {
      id: 604,
      title: 'Сделать задачу',
      board_id: BOARD,
      properties: { id_4: 'Коротко для фаундера.', id_2: [21] },
      checklists: [
        { id: 1, name: 'Агент · Критерии готовности', items: [{ id: 11, text: 'Дописал человек', checked: false }] },
        { id: 2, name: 'Агент · Старый раздел', items: [{ id: 21, text: 'Пункт', checked: true }] },
      ],
    });
    const dry = await runKaitenSync(w.fake.client, w.input(), 'details');
    const line = formatPlan(dry).join('\n');
    expect(line).toContain('пунктов нет в файле — оставим 1: «Дописал человек»');
    expect(line).toContain('чек-листов нет в файле — оставим 1: «Агент · Старый раздел»');
    expect(line).not.toContain('УДАЛИТЬ');

    await w.sync();
    const lists = w.fake.cards.get(604)?.checklists.map((l) => [l.name, l.items.map((i) => i.text)]);
    expect(lists).toEqual([
      ['Агент · Критерии готовности', ['Дописал человек', 'Из файла']],
      ['Агент · Старый раздел', ['Пункт']],
    ]);
    expect(w.fake.writes.some((x) => x.startsWith('DELETE'))).toBe(false);
  });
});

describe('файлы карточки: вложения и журнал', () => {
  /** Хранилище вложений: slug → вложения, sha → содержимое. */
  function withFiles(w: ReturnType<typeof world>) {
    const refs = new Map<string, AttachmentRef[]>();
    const blobs = new Map<string, Uint8Array>();
    const attach = (slug: string, name: string, text: string) => {
      const content = new TextEncoder().encode(text);
      const sha = `sha-${slug}-${name}-${text.length}-${blobs.size}`;
      blobs.set(sha, content);
      refs.set(slug, [...(refs.get(slug) ?? []).filter((r) => r.name !== name), { name, sha, size: content.length }]);
    };
    const extra = (more: Partial<RunInput> = {}): Partial<RunInput> => ({
      attachments: refs,
      readFile: (sha) => blobs.get(sha) ?? new Uint8Array(),
      ...more,
    });
    const names = (cardId: number) => (w.fake.cards.get(cardId)?.files ?? []).map((f) => f.name).sort();
    const text = (cardId: number, name: string) => new TextDecoder().decode(w.fake.cards.get(cardId)?.files?.find((f) => f.name === name)?.content);
    return { attach, extra, names, text };
  }

  it('новая карточка получает вложения и журнал; files_hash — в задачу; повтор — без записей', async () => {
    const [path, text] = task('active/new.md', { status: 'inbox', created_via: 'agent' });
    const w = world([[path, text], ['active/new.log.md', '## [2026-09-28] Начал\n\nЧерновик готов.\n']]);
    const f = withFiles(w);
    f.attach('new', 'DRAFT.md', '# Черновик');
    f.attach('new', 'img/scheme.md', 'схема');
    const run = await w.sync(f.extra());
    expect(run.errors).toEqual([]);
    const card = [...w.fake.cards.values()][0];
    expect(f.names(card.id)).toEqual(['DRAFT.md', 'img/scheme.md', 'ЖУРНАЛ.md']);
    expect(f.text(card.id, 'ЖУРНАЛ.md')).toContain('Черновик готов.');
    expect(w.texts.get(path)).toMatch(/files_hash: sha256:/);

    const writes = w.fake.writes.length;
    const second = await w.sync(f.extra());
    expect(second.plan.actions).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
  });

  it('новая запись журнала: заменяется только ЖУРНАЛ.md — описание, чек-листы и чужие файлы не трогаются', async () => {
    const [path, text] = task('active/new.md', { status: 'inbox', created_via: 'agent' });
    const w = world([[path, text], ['active/new.log.md', '## [2026-09-28] Начал\n']]);
    const f = withFiles(w);
    await w.sync(f.extra());
    const card = [...w.fake.cards.values()][0];
    card.files?.push({ id: '00000000-0000-4000-8000-999999999999', name: 'от заказчика.pdf', content: new Uint8Array([1, 2]) });
    w.fake.writes.length = 0;

    w.texts.set('active/new.log.md', '## [2026-09-28] Начал\n\n## [2026-09-29] Продолжил\n');
    const run = await w.sync(f.extra());
    expect(run.errors).toEqual([]);
    expect(f.text(card.id, 'ЖУРНАЛ.md')).toContain('Продолжил');
    expect(f.names(card.id)).toEqual(['ЖУРНАЛ.md', 'от заказчика.pdf']);
    expect(w.fake.writes.every((x) => x.includes('/files'))).toBe(true);
    expect(w.fake.writes.some((x) => x.startsWith('DELETE') && x.includes('999999999999'))).toBe(false);
  });

  it('карточка без files_hash: фон файлы не шлёт; --resend — открытым, закрытым — только через --only', async () => {
    const [openPath, openText] = task('active/open.md', { tracker: '700' });
    const [donePath, doneText] = task('archive/2026-09/done.md', { tracker: '701', status: 'done' });
    const w = world([[openPath, openText], [donePath, doneText], ['active/open.log.md', '## [2026-09-28] Запись\n'], ['archive/2026-09/done.log.md', '## [2026-09-28] Запись\n']]);
    for (const id of [700, 701]) seedCard(w.fake, { id, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    const f = withFiles(w);
    await w.sync(f.extra());
    expect(f.names(700)).toEqual([]);

    const dry = await runKaitenSync(w.fake.client, { ...w.input(), ...f.extra({ resend: true }) }, 'details');
    expect(formatPlan(dry).join('\n')).toContain('файлы: загрузить 1: «ЖУРНАЛ.md»');
    await w.sync(f.extra({ resend: true }));
    expect(f.names(700)).toEqual(['ЖУРНАЛ.md']);
    expect(f.names(701)).toEqual([]);
    expect(w.texts.get(openPath)).toMatch(/files_hash: sha256:/);

    const doneId = tasksOf(w.texts).find((t) => t.slug === 'done')?.fm.id ?? '';
    await w.sync(f.extra({ resend: true, only: new Set([doneId]) }));
    expect(f.names(701)).toEqual(['ЖУРНАЛ.md']);

    // Дальше — сам: повторное вложение с тем же именем заменяет файл.
    f.attach('open', 'R.md', 'v1');
    await w.sync(f.extra());
    f.attach('open', 'R.md', 'v2 длиннее');
    await w.sync(f.extra());
    expect(f.names(700)).toEqual(['R.md', 'ЖУРНАЛ.md']);
    expect(f.text(700, 'R.md')).toBe('v2 длиннее');
  });

  it('обрыв между загрузкой и удалением: повтор нашего файла убирается, совпавший остаётся', async () => {
    const [path, text] = task('active/open.md', { tracker: '710' });
    const w = world([[path, text], ['active/open.log.md', '## [2026-09-28] Запись\n']]);
    seedCard(w.fake, { id: 710, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    const f = withFiles(w);
    await w.sync(f.extra({ resend: true }));
    const card = w.fake.cards.get(710);
    const journal = card?.files?.[0];
    if (!card || !journal) throw new Error('нет журнала');
    card.files?.push({ id: '00000000-0000-4000-8000-000000000777', name: 'ЖУРНАЛ.md', content: new TextEncoder().encode('старый') });
    const run = await w.sync(f.extra({ resend: true }));
    expect(formatPlan(run).join('\n')).toContain('убрать повторов 1');
    expect(card.files?.map((x) => x.id)).toEqual([journal.id]);
  });

  it('файлы — только по UUID карточки, по подписанной ссылке — без токена', async () => {
    const [path, text] = task('active/open.md', { tracker: '720' });
    const w = world([[path, text], ['active/open.log.md', '## [2026-09-28] Запись\n']]);
    seedCard(w.fake, { id: 720, title: 'Сделать задачу', board_id: BOARD, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
    const f = withFiles(w);
    await w.sync(f.extra({ resend: true }));
    await w.sync(f.extra({ resend: true }));
    expect(w.fake.signedFetches.length).toBeGreaterThan(0);
    for (const headers of w.fake.signedFetches) expect(JSON.stringify(headers)).not.toMatch(/authorization|secret-token/i);
    expect(w.fake.numericFileRequests).toEqual([]);
    await expect(w.fake.client.uploadCardFile('720', 'x.md', new Uint8Array())).rejects.toThrow(/UUID/);
    expect(w.fake.numericFileRequests).toEqual([]);
  });

  it('kaiten edit не сбрасывает files_hash', () => {
    const [path, text] = task('active/open.md', { tracker: '730', files_hash: `sha256:${'a'.repeat(64)}` });
    const texts = new Map([[path, text]]);
    const [current] = tasksOf(texts);
    const edited = text.replace(`files_hash: sha256:${'a'.repeat(64)}\n`, '').replace('- [ ] Ещё', '- [ ] Ещё один');
    const r = applyOp({ kind: 'edit', id: current.fm.id, text: edited, baseHash: contentHash(current.fm, current.body) }, texts, { date: '2026-09-28', stamp: '2026-09-28 10:15:00 +03:00' });
    if ('error' in r) throw new Error(r.error);
    expect(r.changes[0].text).toContain(`files_hash: sha256:${'a'.repeat(64)}`);
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

  describe('архив Kaiten вместо дорожки (archiveInKaiten)', () => {
    const ARCHIVE = { mapping: LANES, now: NOW, archiveInKaiten: true };

    it('закрыта больше месяца назад — в архив последней записью, на дорожку «Архив» не переносим', async () => {
      const { w, lane } = laneWorld({ status: 'done' }, { lane_id: 41, column_id: 107, column_changed_at: DAYS_AGO(31) });
      const plan = await runKaitenSync(w.fake.client, { ...w.input(), ...ARCHIVE }, 'plan');
      expect(formatPlan(plan).join('\n')).toMatch(/в архив Kaiten/);
      await w.sync(ARCHIVE);
      const card = w.fake.cards.get(600);
      expect(card?.archived).toBe(true);
      expect(lane()).toBe(41);
      // Описание ещё не доставлялось — доставлено до архива.
      expect(card?.description).toContain(Q41_NOTICE);
      expect(w.fake.writes.at(-1)).toBe('PATCH /cards/600');
      w.fake.writes.length = 0;
      await w.sync(ARCHIVE);
      expect(w.fake.writes).toEqual([]);
    });

    it('закрыта недавно или открыта — не архивируем', async () => {
      const recent = laneWorld({ status: 'cancelled' }, { lane_id: 41, column_id: 108, column_changed_at: DAYS_AGO(5) });
      await recent.w.sync(ARCHIVE);
      expect(recent.w.fake.cards.get(600)?.archived).toBe(false);
      const open = laneWorld({ status: 'in-progress' }, { lane_id: 41, column_id: 104, column_changed_at: DAYS_AGO(90) });
      await open.w.sync(ARCHIVE);
      expect(open.w.fake.cards.get(600)?.archived).toBe(false);
    });

    it('лежит на дорожке «Архив», а id дорожки ещё в маппинге, — не двигаем: дорожка не используется', async () => {
      const { w, lane } = laneWorld({ status: 'in-progress' }, { lane_id: 49, column_id: 104, column_changed_at: DAYS_AGO(1) });
      await w.sync(ARCHIVE);
      expect(lane()).toBe(49);
    });

    function epicWorld(childArchived: boolean) {
      const epicId = id();
      const [epicPath, epicText] = task('active/epic.md', { id: epicId, type: 'epic', status: 'done', tracker: '700', repo: undefined });
      const [childPath, childText] = task('active/child.md', { status: 'in-progress', tracker: '701', epic: epicId });
      const w = world([[epicPath, epicText], [childPath, childText]]);
      seedCard(w.fake, { id: 700, title: 'Сделать задачу', board_id: BOARD, type_id: 1, lane_id: 20, column_id: 107, column_changed_at: DAYS_AGO(40), properties: { id_4: 'Коротко для фаундера.' } });
      seedCard(w.fake, { id: 701, title: 'Сделать задачу', board_id: BOARD, lane_id: 41, column_id: childArchived ? 107 : 104, parents_ids: [700], archived: childArchived, properties: { id_4: 'Коротко для фаундера.', id_2: [21] } });
      return w;
    }

    it('эпик — в архив, только когда у него нет живых дочерних карточек', async () => {
      const live = epicWorld(false);
      await live.sync(ARCHIVE);
      expect(live.fake.cards.get(700)?.archived).toBe(false);
      const gone = epicWorld(true);
      await gone.sync(ARCHIVE);
      expect(gone.fake.cards.get(700)?.archived).toBe(true);
    });

    it('к архивному эпику задачу не привязываем', async () => {
      const w = epicWorld(false);
      const epic = w.fake.cards.get(700);
      const child = w.fake.cards.get(701);
      if (!epic || !child) throw new Error('нет карточек');
      epic.archived = true;
      child.parents_ids = [];
      await w.sync(ARCHIVE);
      expect(w.fake.writes).not.toContain('POST /cards/700/children');
    });
  });
});

describe('поля «Можно младшему»', () => {
  const JUNIOR = { state: 'on' as const, maxAgeDays: 90, property: { id: 7, yes: 71, no: 72 }, missingPropertyId: 8 };
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const READY = '## Продуктовые решения\n\nНет.\n\n## Изменения в БД\n\nНет — только чтение.\n\n## Сценарии n8n\n\nНет.\n\n## Критерии готовности\n\n- [ ] Ещё\n';
  const seeded = { board_id: BOARD, title: 'Сделать задачу', properties: { id_4: 'Коротко для фаундера.', id_2: [21] } };

  it('готовая задача — «Да» без причин; второй прогон — ни одной записи', async () => {
    const [path, text] = task('active/ready.md', { tracker: '800', updated: '2026-09-20' }, READY);
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 800, ...seeded });
    expect((await w.sync({ junior: JUNIOR, now: NOW })).errors).toEqual([]);
    const card = w.fake.cards.get(800);
    expect(card?.properties.id_7).toEqual([71]);
    expect(card?.properties.id_8 ?? null).toBeNull();
    const writes = w.fake.writes.length;
    expect((await w.sync({ junior: JUNIOR, now: NOW })).plan.actions).toEqual([]);
    expect(w.fake.writes.length).toBe(writes);
  });

  it('неготовая — «Нет» с причинами; задачу освежили — «Да», причины стираются', async () => {
    const [path, text] = task('active/old.md', { tracker: '801', updated: '2026-06-01' }, READY);
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 801, ...seeded });
    await w.sync({ junior: JUNIOR, now: NOW });
    const card = w.fake.cards.get(801);
    expect(card?.properties).toMatchObject({ id_7: [72], id_8: 'задача старше 90 дней' });

    w.texts.set(path, (w.texts.get(path) ?? '').replace('updated: 2026-06-01', 'updated: 2026-09-30'));
    await w.sync({ junior: JUNIOR, now: NOW });
    expect(card?.properties).toMatchObject({ id_7: [71], id_8: null });
  });

  it('без разделов — причины по каждому; взяли в работу — оба поля пустые', async () => {
    const [path, text] = task('active/bare.md', { tracker: '802', updated: '2026-09-20' });
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 802, ...seeded });
    await w.sync({ junior: JUNIOR, now: NOW });
    const card = w.fake.cards.get(802);
    expect(card?.properties).toMatchObject({ id_7: [72], id_8: 'продукт: нет раздела; БД: нет раздела; n8n: нет раздела' });

    w.texts.set(path, (w.texts.get(path) ?? '').replace('status: backlog', 'status: in-progress'));
    await w.sync({ junior: JUNIOR, now: NOW });
    expect(card?.properties).toMatchObject({ id_7: null, id_8: null });
  });

  it('новая карточка получает признак; пустое поле не передаётся', async () => {
    const [path, text] = task('active/new.md', { created_via: 'agent', updated: '2026-09-20' }, READY);
    const w = world([[path, text]]);
    const run = await w.sync({ junior: JUNIOR, now: NOW });
    expect(run.errors).toEqual([]);
    const card = [...w.fake.cards.values()].find((c) => c.title === 'Сделать задачу');
    expect(card?.properties.id_7).toEqual([71]);
    expect(card?.properties).not.toHaveProperty('id_8');
  });

  it('сухой прогон владельца — сколько карточек получат «Да», «Нет» и пустое поле', async () => {
    const w = world([
      task('active/a.md', { tracker: '810', updated: '2026-09-20' }, READY),
      task('active/b.md', { tracker: '811', updated: '2026-09-20' }),
      task('active/c.md', { tracker: '812', updated: '2026-09-20', status: 'in-progress' }, READY),
    ]);
    for (const id of [810, 811]) seedCard(w.fake, { id, ...seeded });
    seedCard(w.fake, { id: 812, ...seeded, column_id: 104, properties: { ...seeded.properties, id_7: [71] } });
    const run = await runKaitenSync(w.fake.client, { ...w.input(), junior: JUNIOR, now: NOW }, 'plan');
    expect(formatPlan(run)).toContain('«Можно младшему»: «Да» — 1, «Нет» — 1, очистить — 1');
    expect(w.fake.writes).toEqual([]);
  });

  it('проект без полей признака — ничего не пишем', async () => {
    const [path, text] = task('active/off.md', { tracker: '803', updated: '2026-09-20' }, READY);
    const w = world([[path, text]]);
    seedCard(w.fake, { id: 803, ...seeded });
    await w.sync({ now: NOW });
    expect(w.fake.cards.get(803)?.properties).not.toHaveProperty('id_7');
  });
});
