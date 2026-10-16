/**
 * Режим «Задачи» агентского сервера на поддельном Kaiten.
 *
 * Главное, что проверяется: всё обязательное проверяется ДО записи, и агент
 * получает один отказ со всем списком — поля с вариантами и пояснениями из
 * описания доски, шаблон названия, дорожка, родитель, дубль. Запись — только
 * вторым шагом с кодом предпросмотра.
 */
import { describe, expect, it } from 'vitest';

import { compileTitle, normalizeTitle, parseBoardDescription, titleProblem } from '../agent-server/board-rules.js';
import { handleMcp } from '../agent-server/mcp.js';
import { checkCode, issueCode } from '../agent-server/preview.js';
import { parseRestrictions, verdict } from '../agent-server/restrictions.js';

const SECRET = 's'.repeat(40);
const DOMAIN = 'acme.example.com';

// ── поддельный Kaiten ───────────────────────────────────────────────────────

const SALES_DESCRIPTION = `> ⚙ Описание для ИИ-агентов.

## Доска
Продажи Acme.

## Этапы
- **Лид** — новый контакт.
- **Демо** — показ. Нужен «Сегмент».
- **Готово** — итог.

## Дорожки
Пилот, Покупка.

## Поля
- **Источник** — откуда пришёл клиент.
- **Сегмент** — тип бизнеса клиента.

## Правила
\`\`\`yaml
version: 1
duplicates: board
types:
  Сделка:
    title: "{Клиент} — {Суть}"
    lane: choose
    parent: none
\`\`\`
`;

const DEV_DESCRIPTION = `## Доска
Разработка.

## Этапы
- **Входящие** — новые.
- **Бэклог** — принято.
- **Сделано** — готово.

## Поля
Нет.

## Правила
\`\`\`yaml
version: 1
columns: [Входящие]
synced: true
types:
  Story:
    title: "{Суть}"
    lane: default
    parent: none
\`\`\`
`;

interface FakeCard {
  id: number;
  title: string;
  board_id: number;
  column_id: number;
  lane_id: number;
  type_id: number;
  properties: Record<string, unknown>;
  external_id?: string | null;
  children_ids?: number[];
  parents_ids?: number[];
}

function fakeKaiten() {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const boards: Record<number, Record<string, unknown>> = {
    10: {
      id: 10,
      title: 'Продажи',
      description: SALES_DESCRIPTION,
      default_card_type_id: 100,
      columns: [
        { id: 101, title: 'Лид', type: 1, sort_order: 1 },
        { id: 102, title: 'Демо', type: 2, sort_order: 2 },
        { id: 103, title: 'Готово', type: 3, sort_order: 3 },
      ],
      lanes: [
        { id: 11, title: 'Пилот', sort_order: 1 },
        { id: 12, title: 'Покупка', sort_order: 2 },
      ],
    },
    20: {
      id: 20,
      title: 'Без правил',
      description: null,
      columns: [{ id: 201, title: 'Очередь', type: 1, sort_order: 1 }],
      lanes: [{ id: 21, title: null, sort_order: 1 }],
    },
    30: {
      id: 30,
      title: 'Задачи',
      description: DEV_DESCRIPTION,
      default_card_type_id: 300,
      columns: [
        { id: 301, title: 'Входящие', type: 1, sort_order: 1 },
        { id: 302, title: 'Бэклог', type: 1, sort_order: 2 },
        { id: 303, title: 'Сделано', type: 3, sort_order: 3 },
      ],
      lanes: [{ id: 31, title: '', sort_order: 1 }],
    },
  };
  const cards: FakeCard[] = [
    { id: 500, title: 'Globex — 2 установки', board_id: 10, column_id: 101, lane_id: 12, type_id: 100, properties: {} },
    { id: 501, title: 'Старая — закрыта', board_id: 10, column_id: 103, lane_id: 12, type_id: 100, properties: {} },
    { id: 600, title: 'Синхронная задача', board_id: 30, column_id: 302, lane_id: 31, type_id: 300, properties: {}, external_id: 'T-1' },
  ];
  let nextId = 900;
  const routes: Array<[string, RegExp, (m: RegExpExecArray, body: Record<string, unknown>) => unknown]> = [
    ['GET', /^\/users\/current$/, () => ({ id: 7, full_name: 'Alice', email: 'alice@example.com' })],
    ['GET', /^\/spaces$/, () => [{ id: 1, uid: 'u1', title: 'Acme', boards: [{ id: 10 }, { id: 20 }, { id: 30 }] }]],
    ['GET', /^\/boards\/(\d+)$/, (m) => boards[Number(m[1])]],
    ['GET', /^\/card-types$/, () => [
      { id: 100, name: 'Сделка', card_properties: [{ property_uid: 'p-src', required: false }, { property_uid: 'p-seg', required: false }] },
      { id: 300, name: 'Story', card_properties: [] },
    ]],
    ['GET', /^\/company\/custom-properties$/, () => [
      { id: 1, uid: 'p-src', name: 'Источник', type: 'select' },
      { id: 2, uid: 'p-seg', name: 'Сегмент', type: 'select' },
    ]],
    ['GET', /^\/company\/custom-properties\/1\/select-values$/, () => [{ id: 41, value: 'Сайт' }, { id: 42, value: 'Звонок' }]],
    ['GET', /^\/company\/custom-properties\/2\/select-values$/, () => [{ id: 51, value: 'Карьер' }, { id: 52, value: 'Стройка' }]],
    ['GET', /^\/spaces\/1\/restrictions$/, () => [
      {
        name: 'Сделка без источника',
        status: 'active',
        error_text: 'Укажите источник.',
        conditions: [{ type: 'cardProperty', operator: 'eq', data: { comparator: 'or', properties: [{ propertyKey: 'id_1', comparator: 'noSet', value: null }] } }],
        restrictions: [{ type: 'creation', data: { path: { boardId: 10 } } }],
      },
      {
        name: 'В демо — после квалификации',
        status: 'active',
        error_text: 'Заполните сегмент.',
        conditions: [{ type: 'cardProperty', operator: 'eq', data: { comparator: 'or', properties: [{ propertyKey: 'id_2', comparator: 'noSet', value: null }] } }],
        restrictions: [{ type: 'movement', data: { path: { boardId: 10, columnId: 102 } } }],
      },
    ]],
    ['GET', /^\/cards$/, () => cards],
    ['GET', /^\/cards\/(\d+)$/, (m) => cards.find((c) => c.id === Number(m[1]))],
    ['POST', /^\/cards$/, (_, body) => {
      const card = { id: nextId++, ...(body as Omit<FakeCard, 'id'>) };
      cards.push(card);
      return card;
    }],
    ['PATCH', /^\/cards\/(\d+)$/, (m, body) => {
      const card = cards.find((c) => c.id === Number(m[1]));
      if (!card) return undefined;
      Object.assign(card, { ...body, properties: { ...card.properties, ...((body.properties as Record<string, unknown>) ?? {}) } });
      return card;
    }],
    ['POST', /^\/cards\/\d+\/(tags|comments|members|children)$/, () => ({})],
    ['PATCH', /^\/cards\/\d+\/members\/\d+$/, () => ({})],
  ];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/latest', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') writes.push({ method, path, body });
    for (const [verb, re, handler] of routes) {
      const m = re.exec(path);
      if (verb === method && m) {
        const value = handler(m, body);
        if (value === undefined) return new Response('{}', { status: 404 });
        const page = Array.isArray(value) && url.searchParams.get('offset') && url.searchParams.get('offset') !== '0' ? [] : value;
        return new Response(JSON.stringify(page), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: `нет маршрута ${method} ${path}` }), { status: 404 });
  };
  return { fetchImpl, writes, cards };
}

async function tool(fake: ReturnType<typeof fakeKaiten>, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const request = new Request('https://agent.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const response = await handleMcp(request, { domain: DOMAIN, token: 't', secret: SECRET, fetchImpl: fake.fetchImpl });
  const json = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: json.result.content[0].text, isError: json.result.isError === true };
}

const GOOD = {
  board_id: 10,
  title: 'Initech — пилот на карьере',
  lane: 'Пилот',
  fields: { Источник: 'сайт' },
  user_request: 'заведи сделку с Initech',
};

// ── правила ─────────────────────────────────────────────────────────────────

describe('правила доски', () => {
  it('разбирает описание и находит разделы', () => {
    const parsed = parseBoardDescription(SALES_DESCRIPTION);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rules.types['Сделка'].lane).toBe('choose');
  });

  it('нет описания, нет блока, сломанный YAML, лишний ключ — закрыто с причиной', () => {
    expect(parseBoardDescription(null)).toEqual({ ok: false, problems: ['у доски нет описания для агентов'] });
    const noBlock = parseBoardDescription('## Доска\nx\n## Этапы\nx\n## Поля\nx');
    expect(!noBlock.ok && noBlock.problems.join()).toMatch(/нет блока правил/);
    const broken = parseBoardDescription('## Доска\n## Этапы\n## Поля\n## Правила\n```yaml\ntypes: [\n```');
    expect(!broken.ok && broken.problems.join()).toMatch(/YAML/);
    const extra = parseBoardDescription('## Доска\n## Этапы\n## Поля\n## Правила\n```yaml\nversion: 1\nlol: 1\ntypes:\n  A:\n    title: "{x}"\n```');
    expect(!extra.ok && extra.problems.join()).toMatch(/lol|Unrecognized/);
  });

  it('шаблон названия: литералы буквально, части непустые', () => {
    expect(titleProblem('{Клиент} — {Суть}', 'Acme — пилот')).toBeNull();
    expect(titleProblem('{Клиент} — {Суть}', 'Acme пилот')).toMatch(/шаблону/);
    expect(titleProblem('{Клиент} · установка {Номер} — {Узел}', 'Acme · установка 2 — прицеп')).toBeNull();
    expect(compileTitle('{A} (x) — {B}').parts).toEqual(['A', 'B']);
  });

  it('нормализация для дублей: регистр, ё, кавычки, пробелы', () => {
    expect(normalizeTitle('  «Ёлка»   — Пилот ')).toBe(normalizeTitle('елка — пилот'));
  });

  it('ограничения (семантика снята живьём): «не задано», «из запрещённой колонки», «дети не готовы»', () => {
    const [noSource] = parseRestrictions([
      { status: 'active', conditions: [{ type: 'cardProperty', data: { comparator: 'or', properties: [{ propertyKey: 'id_1', comparator: 'noSet' }] } }], restrictions: [] },
    ]);
    expect(verdict(noSource, { typeId: 1, fromColumnId: null, properties: {} })).toBe('blocks');
    expect(verdict(noSource, { typeId: 1, fromColumnId: null, properties: { id_1: [41] } })).toBe('passes');
    const [onlyFrom] = parseRestrictions([
      { status: 'active', conditions: [{ type: 'prevCardPath', operator: 'eq', data: { paths: [{ path: { columnId: 4 } }] } }], restrictions: [] },
    ]);
    expect(verdict(onlyFrom, { typeId: 1, fromColumnId: 4, properties: {} })).toBe('blocks');
    expect(verdict(onlyFrom, { typeId: 1, fromColumnId: 5, properties: {} })).toBe('passes');
    const [children] = parseRestrictions([{ status: 'active', conditions: [{ type: 'childCardsDone', operator: 'eq', data: {} }], restrictions: [] }]);
    expect(verdict(children, { typeId: 1, fromColumnId: 1, properties: {} })).toBe('unknown');
    expect(verdict(children, { typeId: 1, fromColumnId: 1, properties: {}, childrenDone: false })).toBe('blocks');
    expect(verdict(children, { typeId: 1, fromColumnId: 1, properties: {}, childrenDone: true })).toBe('passes');
  });

  it('код предпросмотра привязан к содержимому, человеку и сроку', async () => {
    const code = await issueCode({ a: 1, b: [2] }, 7, SECRET, 1000);
    expect(await checkCode(code, { b: [2], a: 1 }, 7, SECRET, 2000)).toBe('ok');
    expect(await checkCode(code, { a: 2, b: [2] }, 7, SECRET, 2000)).toBe('mismatch');
    expect(await checkCode(code, { a: 1, b: [2] }, 8, SECRET, 2000)).toBe('mismatch');
    expect(await checkCode(code, { a: 1, b: [2] }, 7, SECRET, 1000 + 11 * 60 * 1000)).toBe('expired');
  });
});

// ── инструменты ─────────────────────────────────────────────────────────────

describe('инструменты задач', () => {
  it('доска без правил — закрыта, запись отказывает с причиной', async () => {
    const fake = fakeKaiten();
    const rules = await tool(fake, 'board_rules', { board_id: 20 });
    expect(rules.text).toMatch(/ЗАКРЫТА/);
    const create = await tool(fake, 'create_card', { ...GOOD, board_id: 20, title: 'x' });
    expect(create.isError).toBe(true);
    expect(create.text).toMatch(/закрыта для записи/);
    expect(fake.writes).toEqual([]);
  });

  it('правила доски — с вариантами и пояснениями полей', async () => {
    const rules = await tool(fakeKaiten(), 'board_rules', { board_id: 10 });
    expect(rules.text).toContain('Создавать можно в колонках: Лид');
    expect(rules.text).toMatch(/«Источник» \(выбор: Сайт, Звонок\) — откуда пришёл клиент/);
    expect(rules.text).toMatch(/Перенос в «Демо»: Заполните сегмент/);
  });

  it('всё не так — один отказ со всем списком, без записи', async () => {
    const fake = fakeKaiten();
    const reply = await tool(fake, 'create_card', { board_id: 10, title: 'Initech пилот', user_request: 'x' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/выберите дорожку: Пилот, Покупка/);
    expect(reply.text).toMatch(/шаблону «\{Клиент\} — \{Суть\}»/);
    expect(reply.text).toMatch(/заполните «Источник» \(выбор: Сайт, Звонок\) — откуда пришёл клиент/);
    expect(fake.writes).toEqual([]);
  });

  it('неверное значение поля и неизвестное поле — с допустимыми значениями', async () => {
    const reply = await tool(fakeKaiten(), 'create_card', { ...GOOD, fields: { Источник: 'Сарафан', Бюджет: 5 } });
    expect(reply.text).toMatch(/«Сарафан» — нет такого варианта; допустимо: Сайт, Звонок/);
    expect(reply.text).toMatch(/поля «Бюджет» на этой доске нет/);
  });

  it('дубль среди открытых — отказ со ссылкой; закрытая не мешает', async () => {
    const dup = await tool(fakeKaiten(), 'create_card', { ...GOOD, title: '«GLOBEX» —  2 установки' });
    expect(dup.text).toMatch(/такая карточка уже есть.*\/card\/500/);
    const closed = await tool(fakeKaiten(), 'create_card', { ...GOOD, title: 'Старая — закрыта' });
    expect(closed.isError).toBe(false);
  });

  it('предпросмотр → код → запись, с меткой, комментарием и ответственным', async () => {
    const fake = fakeKaiten();
    const preview = await tool(fake, 'create_card', GOOD);
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/ПРЕДПРОСМОТР/);
    expect(preview.text).toMatch(/Источник: Сайт/);
    expect(fake.writes).toEqual([]);
    const code = /confirm_code: (\S+)/.exec(preview.text)?.[1];

    const changed = await tool(fake, 'create_card', { ...GOOD, title: 'Initech — другое', confirm_code: code });
    expect(changed.text).toMatch(/Код не подходит/);
    expect(fake.writes).toEqual([]);

    const done = await tool(fake, 'create_card', { ...GOOD, confirm_code: code });
    expect(done.text).toMatch(/Карточка заведена: #900/);
    expect(fake.writes[0]).toMatchObject({ method: 'POST', path: '/cards', body: { column_id: 101, lane_id: 11, type_id: 100, properties: { id_1: [41] } } });
    expect(fake.writes.map((w) => w.path)).toEqual(['/cards', '/cards/900/tags', '/cards/900/comments', '/cards/900/members', '/cards/900/members/7']);
    expect(fake.writes[2].body).toMatchObject({ text: expect.stringContaining('заведи сделку с Initech') });

    const again = await tool(fake, 'create_card', { ...GOOD, confirm_code: code });
    expect(again.text).toMatch(/такая карточка уже есть/);
  });

  it('перенос: ограничение требует поле — отказ; с полем в том же вызове — проходит', async () => {
    const fake = fakeKaiten();
    const blocked = await tool(fake, 'move_card', { card: 500, column: 'Демо' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/заполните «Сегмент» \(выбор: Карьер, Стройка\) — тип бизнеса клиента/);
    expect(fake.writes).toEqual([]);
    const moved = await tool(fake, 'move_card', { card: `https://${DOMAIN}/space/1/card/500`, column: 'Демо', fields: { Сегмент: 'Карьер' } });
    expect(moved.isError).toBe(false);
    expect(fake.writes).toEqual([{ method: 'PATCH', path: '/cards/500', body: { column_id: 102, properties: { id_2: [51] } } }]);
  });

  it('доска разработки: создание только во «Входящие», git-карточки — только комментарий', async () => {
    const fake = fakeKaiten();
    const backlog = await tool(fake, 'create_card', { board_id: 30, title: 'Новая задача', column: 'Бэклог', user_request: 'x' });
    expect(backlog.text).toMatch(/заводить можно только в: Входящие/);
    const ok = await tool(fake, 'create_card', { board_id: 30, title: 'Новая задача', user_request: 'x' });
    expect(ok.text).toMatch(/Входящие; дорожка: по умолчанию; тип: Story/);
    const edit = await tool(fake, 'update_card', { card: 600, description: 'x' });
    expect(edit.text).toMatch(/ведут разработчики через git/);
    const comment = await tool(fake, 'add_comment', { card: 600, text: 'вопрос' });
    expect(comment.isError).toBe(false);
    expect(fake.writes).toEqual([{ method: 'POST', path: '/cards/600/comments', body: { text: 'вопрос' } }]);
  });
});
