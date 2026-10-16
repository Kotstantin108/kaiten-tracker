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
import { addWorkingDays, todayIn } from '../agent-server/due.js';
import { fileProblems } from '../agent-server/card-files.js';
import { confirmRoute, uploadRoute } from '../agent-server/human-pages.js';
import { sealToken } from '../agent-server/key.js';
import { handleMcp } from '../agent-server/mcp.js';
import { checkCode, issueCode } from '../agent-server/preview.js';
import { parseRestrictions, verdict } from '../agent-server/restrictions.js';
import { makeSession, SESSION_COOKIE } from '../agent-server/session.js';
import { MemoryStore } from '../agent-server/store.js';

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

const ORDERS_DESCRIPTION = `## Доска
Поручения сотрудникам.

## Этапы
- **Новые** — поручено.

## Поля
Нет.

## Правила
\`\`\`yaml
version: 1
comments: confirm
types:
  Поручение:
    responsible: required
    due: required
    due_default: 3
\`\`\`
`;

const CARD_UID = '0a000000-0000-4000-8000-000000000600';

interface FakeCard {
  id: number;
  uid?: string;
  service_id?: number | null;
  title: string;
  board_id: number;
  column_id: number;
  lane_id: number;
  type_id: number;
  properties: Record<string, unknown>;
  external_id?: string | null;
  children_ids?: number[];
  parents_ids?: number[];
  files?: Array<{ id: string; name: string; size: string; type: number }>;
  checklists?: Array<{ id: number; name: string; items: Array<{ id: number; text: string; checked: boolean; sort_order: number }> }>;
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
      default_card_type_id: 300,
      columns: [
        { id: 201, title: 'Очередь', type: 1, sort_order: 1 },
        { id: 202, title: 'В работе', type: 2, sort_order: 2 },
      ],
      lanes: [{ id: 21, title: null, sort_order: 1 }],
    },
    40: {
      id: 40,
      title: 'Сломанные правила',
      description: '## Доска\nx\n## Правила\nблок забыли',
      default_card_type_id: 300,
      columns: [{ id: 401, title: 'Очередь', type: 1, sort_order: 1 }],
      lanes: [{ id: 41, title: null, sort_order: 1 }],
    },
    50: {
      id: 50,
      title: 'Только чтение',
      description: '## Правила\n```yaml\nversion: 1\naccess: read\ntypes:\n  "*": {}\n```',
      default_card_type_id: 300,
      columns: [{ id: 501, title: 'Очередь', type: 1, sort_order: 1 }],
      lanes: [{ id: 51, title: null, sort_order: 1 }],
    },
    60: {
      id: 60,
      title: 'Без типа',
      description: null,
      columns: [{ id: 601, title: 'Очередь', type: 1, sort_order: 1 }],
      lanes: [{ id: 61, title: null, sort_order: 1 }],
    },
    70: {
      id: 70,
      title: 'Поручения',
      description: ORDERS_DESCRIPTION,
      default_card_type_id: 300,
      columns: [{ id: 701, title: 'Новые', type: 1, sort_order: 1 }],
      lanes: [{ id: 71, title: null, sort_order: 1 }],
    },
    30: {
      id: 30,
      title: 'Задачи',
      description: DEV_DESCRIPTION,
      default_card_type_id: 300,
      columns: [
        { id: 301, title: 'Входящие', type: 1, sort_order: 1 },
        { id: 302, title: 'Бэклог', type: 1, sort_order: 2 },
        { id: 304, title: 'Ревью', type: 2, sort_order: 3 },
        { id: 303, title: 'Сделано', type: 3, sort_order: 4 },
      ],
      lanes: [{ id: 31, title: '', sort_order: 1 }],
    },
  };
  const cards: FakeCard[] = [
    { id: 500, title: 'Globex — 2 установки', board_id: 10, column_id: 101, lane_id: 12, type_id: 100, properties: {} },
    { id: 501, title: 'Старая — закрыта', board_id: 10, column_id: 103, lane_id: 12, type_id: 100, properties: {} },
    {
      id: 600,
      uid: CARD_UID,
      title: 'Синхронная задача',
      board_id: 30,
      column_id: 302,
      lane_id: 31,
      type_id: 300,
      properties: {},
      external_id: 'T-1',
      files: [
        { id: '00000000-0000-4000-8000-000000000001', name: 'ЖУРНАЛ.md', size: '2048', type: 11 },
        { id: '00000000-0000-4000-8000-000000000002', name: 'DRAFT.md', size: '300', type: 11 },
      ],
      checklists: [
        {
          id: 1,
          name: 'Агент · Критерии',
          items: [
            { id: 2, text: 'Второй', checked: false, sort_order: 2 },
            { id: 1, text: 'Первый', checked: true, sort_order: 1 },
          ],
        },
      ],
    },
    { id: 700, title: 'Задача из git без правил', board_id: 20, column_id: 201, lane_id: 21, type_id: 300, properties: {}, external_id: 'T-2' },
    { id: 701, title: 'Обычная', board_id: 20, column_id: 201, lane_id: 21, type_id: 300, properties: {} },
    { id: 702, title: 'Обращение клиента', board_id: 20, column_id: 201, lane_id: 21, type_id: 300, properties: {}, service_id: 5 },
  ];
  let nextId = 900;
  const routes: Array<[string, RegExp, (m: RegExpExecArray, body: Record<string, unknown>) => unknown]> = [
    ['GET', /^\/users\/current$/, () => ({ id: 7, full_name: 'Alice', email: 'alice@example.com' })],
    ['GET', /^\/spaces$/, () => [
      { id: 1, uid: 'u1', title: 'Acme', boards: [10, 20, 30, 40, 50, 60].map((id) => ({ id })) },
      { id: 2, uid: 'u2', title: 'Поручения', parent_entity_uid: 'u1', boards: [{ id: 70 }] },
    ]],
    // Унаследованных от родителя в списке дочернего пространства нет — как живьём.
    ['GET', /^\/spaces\/1\/users$/, () => [
      { id: 7, full_name: 'Alice', email: 'alice@example.com' },
      { id: 8, full_name: 'Bob Stone', email: 'bob.stone@example.com' },
      { id: 9, full_name: 'Bob Brown', email: 'bob.brown@example.com' },
      { id: 10, full_name: 'Carol Off', email: 'carol@example.com', activated: false },
    ]],
    ['GET', /^\/spaces\/2\/users$/, () => []],
    ['GET', /^\/spaces\/2\/restrictions$/, () => []],
    ['POST', /^\/cards\/([0-9a-f-]{36})\/files$/, (_, body) => ({ id: '0b000000-0000-4000-8000-000000000001', name: body.name, size: String(body.size), type: 11 })],
    ['GET', /^\/boards\/(\d+)$/, (m) => boards[Number(m[1])]],
    ['GET', /^\/card-types$/, () => [
      { id: 100, name: 'Сделка', card_properties: [{ property_uid: 'p-src', required: false }, { property_uid: 'p-seg', required: false }] },
      { id: 300, name: 'Story', card_properties: [] },
      { id: 400, name: 'Поручение', card_properties: [] },
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
    let body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      const file = init.body.get('file') as File;
      body = { name: file.name, size: file.size, text: new TextDecoder().decode(await file.arrayBuffer()) };
    } else if (init?.body) body = JSON.parse(String(init.body)) as Record<string, unknown>;
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

interface ToolOptions {
  /** Хранилище подтверждений и ключ агента — как у подключения через сервер. */
  store?: MemoryStore;
  agentKey?: string;
  now?: Date;
}

async function tool(fake: ReturnType<typeof fakeKaiten>, name: string, args: Record<string, unknown>, opts: ToolOptions = {}): Promise<{ text: string; isError: boolean }> {
  const request = new Request('https://agent.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const response = await handleMcp(request, {
    domain: DOMAIN,
    token: 't',
    secret: SECRET,
    fetchImpl: fake.fetchImpl,
    ...(opts.store ? { store: opts.store, publicUrl: 'https://agent.example.com', agentKey: opts.agentKey ?? (await sealToken('t', SECRET)) } : {}),
    ...(opts.now ? { now: () => opts.now as Date } : {}),
  });
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

  it('нет блока — правила по умолчанию, git-карточки только комментируются', () => {
    const empty = parseBoardDescription(null);
    expect(empty.ok && empty.value.defaults).toBe(true);
    expect(empty.ok && empty.value.rules).toMatchObject({ access: 'write', duplicates: 'board', synced: true, types: { '*': { lane: 'default', parent: 'none' } } });
    expect(empty.ok && empty.value.warnings.join()).toMatch(/нет описания/);
    const textOnly = parseBoardDescription('## Доска\nx\n## Этапы\nx\n## Поля\nx');
    expect(textOnly.ok && textOnly.value.defaults && textOnly.value.warnings).toEqual([]);
    const stray = parseBoardDescription('## Доска\nx\n```yaml\nversion: 1\n```');
    expect(stray.ok && stray.value.warnings.join()).toMatch(/вне раздела «## Правила» не читается/);
  });

  it('блок есть, но сломан — закрыто с причиной', () => {
    const noBlock = parseBoardDescription('## Доска\nx\n## Правила\nсм. ниже');
    expect(!noBlock.ok && noBlock.problems.join()).toMatch(/нет блока ```yaml/);
    const broken = parseBoardDescription('## Правила\n```yaml\ntypes: [\n```');
    expect(!broken.ok && broken.problems.join()).toMatch(/YAML/);
    const extra = parseBoardDescription('## Правила\n```yaml\nversion: 1\nlol: 1\ntypes:\n  A:\n    title: "{x}"\n```');
    expect(!extra.ok && extra.problems.join()).toMatch(/lol|Unrecognized/);
  });

  it('неполное описание — предупреждения, не отказ; synced по умолчанию — да', () => {
    const parsed = parseBoardDescription('## Правила\n```yaml\nversion: 1\ntypes:\n  A: {}\n```');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.warnings).toEqual(['в описании нет раздела «Доска»', 'в описании нет раздела «Этапы»', 'в описании нет раздела «Поля»']);
    expect(parsed.value.rules.synced).toBe(true);
    expect(parsed.value.rules.types.A.title).toBeUndefined();
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
  it('доска без правил — открыта на умолчаниях: очередь, тип доски, свободное название', async () => {
    const fake = fakeKaiten();
    const rules = await tool(fake, 'board_rules', { board_id: 20 });
    expect(rules.text).toMatch(/действуют правила по умолчанию/);
    expect(rules.text).toMatch(/Создавать можно в колонках: Очередь\./);
    expect(rules.text).toMatch(/Тип «Story»: название свободное; дорожка — по умолчанию; родитель — не нужен/);
    expect(rules.text).toMatch(/нет описания для агентов/);
    const preview = await tool(fake, 'create_card', { board_id: 20, title: 'Позвонить поставщику', user_request: 'x' });
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/колонка: Очередь; дорожка: по умолчанию; тип: Story/);
    const twin = await tool(fake, 'create_card', { board_id: 20, title: 'обычная', user_request: 'x' });
    expect(twin.text).toMatch(/такая карточка уже есть/);
    const synced = await tool(fake, 'update_card', { card: 700, description: 'x' });
    expect(synced.text).toMatch(/ведут разработчики через git/);
    const plain = await tool(fake, 'update_card', { card: 701, description: 'новое' });
    expect(plain.isError).toBe(false);
    expect(fake.writes).toEqual([{ method: 'PATCH', path: '/cards/701', body: { description: 'новое' } }]);
  });

  it('сломанный блок, access: read, доска без типа — закрыты, причина в отказе', async () => {
    const fake = fakeKaiten();
    const broken = await tool(fake, 'create_card', { board_id: 40, title: 'x', user_request: 'x' });
    expect(broken.text).toMatch(/закрыта для записи агентом[\s\S]*нет блока ```yaml/);
    const readOnly = await tool(fake, 'add_comment', { card: 701, text: 'x' }).then(() => tool(fake, 'create_card', { board_id: 50, title: 'x', user_request: 'x' }));
    expect(readOnly.text).toMatch(/только чтение \(access: read/);
    const noType = await tool(fake, 'board_rules', { board_id: 60 });
    expect(noType.text).toMatch(/ЗАКРЫТА[\s\S]*нет типа по умолчанию/);
    expect(fake.writes.map((w) => w.path)).toEqual(['/cards/701/comments']);
  });

  it('неописанная колонка — предупреждение в правилах, предпросмотре и переносе', async () => {
    const fake = fakeKaiten();
    const rules = await tool(fake, 'board_rules', { board_id: 30 });
    expect(rules.text).toMatch(/Предупреждения об описании доски[\s\S]*не описана колонка «Ревью»/);
    const preview = await tool(fake, 'create_card', { board_id: 30, title: 'Новая задача', user_request: 'x' });
    expect(preview.isError).toBe(false);
    expect(preview.text).toMatch(/не описана колонка «Ревью»/);
    const moved = await tool(fake, 'move_card', { card: 701, column: 'В работе' });
    expect(moved.text).toMatch(/^Готово:[\s\S]*нет описания для агентов/);
  });

  it('список досок — состояние по тем же правилам', async () => {
    const list = await tool(fakeKaiten(), 'list_boards', {});
    expect(list.text).toMatch(/доска 10 «Продажи» — есть правила для агента/);
    expect(list.text).toMatch(/доска 20 «Без правил» — правила по умолчанию/);
    expect(list.text).toMatch(/доска 40 «Сломанные правила» — закрыта: в разделе «Правила» нет блока/);
    expect(list.text).toMatch(/доска 50 «Только чтение» — только чтение \(access: read\)/);
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

  it('карточка — с файлами (имя и размер) и пунктами в порядке интерфейса', async () => {
    const fake = fakeKaiten();
    const card = await tool(fake, 'get_card', { card: 600 });
    expect(card.text).toContain('Файлы (открыть — в карточке Kaiten): ЖУРНАЛ.md (2 КБ), DRAFT.md (300 Б)');
    expect(card.text).toMatch(/\[x\] Первый\n {2}\[ \] Второй/);
  });
});

// ── поручения, подтверждение комментария, файлы ─────────────────────────────

/** Пятница, 16.10.2026: «+3 рабочих дня» — среда, 21.10. */
const FRIDAY = new Date('2026-10-16T10:00:00Z');
const ORDER = { board_id: 70, title: 'Подготовить счёт', type: 'Поручение', user_request: 'поручи Бобу счёт' };

async function cookieOf(userId: number): Promise<string> {
  return `${SESSION_COOKIE}=${await makeSession(userId, SECRET)}`;
}

function linkId(text: string, kind: 'confirm' | 'upload'): string {
  const id = new RegExp(`/${kind}/([A-Za-z0-9_-]+)`).exec(text)?.[1];
  if (!id) throw new Error(`нет ссылки ${kind}: ${text}`);
  return id;
}

describe('сроки и рабочие дни', () => {
  it('сегодня — в поясе пользователя, рабочие дни — пн–пт', () => {
    expect(todayIn('Asia/Vladivostok', new Date('2026-10-16T20:00:00Z'))).toBe('2026-10-17');
    expect(todayIn('Нет/Такого', FRIDAY)).toBe('2026-10-16');
    expect(addWorkingDays('2026-10-16', 3)).toBe('2026-10-21');
    expect(addWorkingDays('2026-10-17', 1)).toBe('2026-10-19');
  });
});

describe('поручение на другого человека', () => {
  it('ответственный обязателен; неоднозначное имя — варианты; человек из пространства выше', async () => {
    const fake = fakeKaiten();
    const none = await tool(fake, 'create_card', ORDER, { now: FRIDAY });
    expect(none.text).toMatch(/укажите ответственного \(responsible\)/);
    const two = await tool(fake, 'create_card', { ...ORDER, responsible: 'Bob' }, { now: FRIDAY });
    expect(two.text).toMatch(/«Bob» — несколько человек: Bob Stone \(bob\.stone@example\.com\), Bob Brown/);
    const off = await tool(fake, 'create_card', { ...ORDER, responsible: 'Carol' }, { now: FRIDAY });
    expect(off.text).toMatch(/«Carol» нет среди тех, у кого есть доступ/);
    expect(fake.writes).toEqual([]);
  });

  it('срок по умолчанию +3 рабочих дня, автор — участник, без комментария; код привязан к адресату', async () => {
    const fake = fakeKaiten();
    const args = { ...ORDER, responsible: 'bob stone' };
    const preview = await tool(fake, 'create_card', args, { now: FRIDAY });
    expect(preview.text).toMatch(/Ответственный: Bob Stone\nУчастник: Alice — автор поручения\nСрок: 2026-10-21 — по умолчанию, \+3 рабочих дня/);
    expect(preview.text).toMatch(/Комментарий с просьбой пользователя не пишем/);
    const code = /confirm_code: (\S+)/.exec(preview.text)?.[1];

    const other = await tool(fake, 'create_card', { ...args, responsible: 'bob.brown@example.com', confirm_code: code }, { now: FRIDAY });
    expect(other.text).toMatch(/Код не подходит/);
    const later = await tool(fake, 'create_card', { ...args, confirm_code: code }, { now: new Date('2026-10-19T10:00:00Z') });
    expect(later.text).toMatch(/Код не подходит/);
    expect(fake.writes).toEqual([]);

    const done = await tool(fake, 'create_card', { ...args, confirm_code: code }, { now: FRIDAY });
    expect(done.text).toMatch(/Карточка заведена/);
    expect(fake.writes[0]).toMatchObject({ path: '/cards', body: { type_id: 400, due_date: '2026-10-21' } });
    expect(fake.writes.map((w) => `${w.method} ${w.path} ${JSON.stringify(w.body)}`)).toEqual([
      expect.stringMatching(/^POST \/cards /),
      'POST /cards/900/tags {"name":"агент"}',
      'POST /cards/900/members {"user_id":8}',
      'PATCH /cards/900/members/8 {"type":2}',
      'POST /cards/900/members {"user_id":7}',
    ]);
  });

  it('срок: свой — берётся; прошедший, кривой и там, где не ставится, — отказ', async () => {
    const fake = fakeKaiten();
    const own = await tool(fake, 'create_card', { ...ORDER, responsible: 'Alice', due: '2026-10-30' }, { now: FRIDAY });
    expect(own.text).toMatch(/Ответственный: Alice\nСрок: 2026-10-30\n/);
    expect(own.text).not.toMatch(/Участник:/);
    expect((await tool(fake, 'create_card', { ...ORDER, responsible: 'Alice', due: '2026-10-15' }, { now: FRIDAY })).text).toMatch(/уже прошёл: сегодня 2026-10-16/);
    expect((await tool(fake, 'create_card', { ...ORDER, responsible: 'Alice', due: '30.10.2026' }, { now: FRIDAY })).text).toMatch(/дата ГГГГ-ММ-ДД/);
    expect((await tool(fake, 'create_card', { ...GOOD, due: '2026-10-30' }, { now: FRIDAY })).text).toMatch(/у типа «Сделка» срок при создании не ставится/);
    const rules = await tool(fake, 'board_rules', { board_id: 70 });
    expect(rules.text).toMatch(/Ответственный: обязательно назвать \(responsible\)[^\n]*Срок: обязателен \(due, ГГГГ-ММ-ДД\); не назван — \+3 рабочих дня/);
    expect(rules.text).toMatch(/Комментарии: только после подтверждения человеком/);
  });
});

describe('комментарий заказчику — после подтверждения человеком', () => {
  it('без хранилища подтверждений — отказ, ничего не отправлено', async () => {
    const fake = fakeKaiten();
    const reply = await tool(fake, 'add_comment', { card: 702, text: 'Готово, проверьте' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/обращение Service Desk/);
    expect(fake.writes).toEqual([]);
  });

  it('Service Desk: ссылка → вход → только свой → «Отправить» → одноразово', async () => {
    const fake = fakeKaiten();
    const store = new MemoryStore();
    const reply = await tool(fake, 'add_comment', { card: 702, text: 'Готово, <проверьте>' }, { store });
    expect(reply.text).toMatch(/НУЖНО ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА/);
    expect(fake.writes).toEqual([]);
    const id = linkId(reply.text, 'confirm');
    const deps = { store, secret: SECRET, domain: DOMAIN, fetchImpl: fake.fetchImpl };
    const url = `https://agent.example.com/confirm/${id}`;

    expect(await (await confirmRoute(new Request(url), deps, id)).text()).toMatch(/Войдите/);
    expect((await confirmRoute(new Request(url, { headers: { Cookie: await cookieOf(8) } }), deps, id)).status).toBe(403);
    const cookie = await cookieOf(7);
    const page = await (await confirmRoute(new Request(url, { headers: { Cookie: cookie } }), deps, id)).text();
    expect(page).toContain('Готово, &#60;проверьте&#62;');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    const post = () => new Request(url, { method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ csrf, decision: 'apply' }) });
    expect(await (await confirmRoute(post(), deps, id)).text()).toMatch(/Отправлено: комментарий к карточке #702/);
    expect(fake.writes).toEqual([{ method: 'POST', path: '/cards/702/comments', body: { text: 'Готово, <проверьте>' } }]);
    expect((await confirmRoute(post(), deps, id)).status).toBe(410);
  });

  it('доска с гостями (comments: confirm) — тоже через ссылку; обычная доска — сразу', async () => {
    const fake = fakeKaiten();
    const store = new MemoryStore();
    fake.cards.push({ id: 703, title: 'Поручение гостю', board_id: 70, column_id: 701, lane_id: 71, type_id: 400, properties: {} });
    expect((await tool(fake, 'add_comment', { card: 703, text: 'x' }, { store })).text).toMatch(/гости или заказчики/);
    expect((await tool(fake, 'add_comment', { card: 701, text: 'x' }, { store })).text).toMatch(/Комментарий добавлен/);
    expect(fake.writes.map((w) => w.path)).toEqual(['/cards/701/comments']);
  });
});

describe('файл в карточку', () => {
  const b64 = (text: string): string => Buffer.from(text).toString('base64');

  it('тип, сигнатура, имя и занятые имена проверяются до записи', () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 счёт');
    expect(fileProblems('счёт.pdf', pdf, [], 100)).toEqual([]);
    expect(fileProblems('счёт.pdf', new TextEncoder().encode('hello'), [], 100).join()).toMatch(/не похоже на \.pdf/);
    expect(fileProblems('run.exe', pdf, [], 100).join()).toMatch(/такой тип файла не загружаем/);
    expect(fileProblems('book.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), [], 100)).toEqual([]);
    expect(fileProblems('a.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), [], 100).join()).toMatch(/такой тип/);
    expect(fileProblems('журнал.MD', pdf, [], 100).join()).toMatch(/занято журналом задачи/);
    expect(fileProblems('Draft.md', new TextEncoder().encode('x'), ['DRAFT.md'], 100).join()).toMatch(/уже есть файл/);
    expect(fileProblems('big.pdf', pdf, [], 5).join()).toMatch(/больше/);
  });

  it('содержимое от агента — в карточку по UUID, и на карточку из git тоже', async () => {
    const fake = fakeKaiten();
    const bad = await tool(fake, 'attach_file', { card: 600, name: 'DRAFT.md', content_base64: b64('# x') });
    expect(bad.text).toMatch(/уже есть файл «DRAFT\.md»/);
    const ok = await tool(fake, 'attach_file', { card: 600, name: 'замечания.csv', content_base64: b64('пункт;статус\n1;открыт\n') });
    expect(ok.text).toMatch(/Файл «замечания\.csv» приложен к #600/);
    expect(fake.writes).toEqual([{ method: 'POST', path: `/cards/${CARD_UID}/files`, body: { name: 'замечания.csv', size: Buffer.byteLength('пункт;статус\n1;открыт\n'), text: 'пункт;статус\n1;открыт\n' } }]);
  });

  it('файл у человека — страница загрузки: проверка файла не гасит ссылку, удачная — гасит', async () => {
    const fake = fakeKaiten();
    const store = new MemoryStore();
    const reply = await tool(fake, 'attach_file', { card: 600 }, { store });
    const id = linkId(reply.text, 'upload');
    const deps = { store, secret: SECRET, domain: DOMAIN, fetchImpl: fake.fetchImpl };
    const url = `https://agent.example.com/upload/${id}`;
    const cookie = await cookieOf(7);
    const page = await (await uploadRoute(new Request(url, { headers: { Cookie: cookie } }), deps, id)).text();
    expect(page).toContain('enctype="multipart/form-data"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    const send = async (name: string, text: string): Promise<Response> => {
      const form = new FormData();
      form.append('csrf', csrf);
      form.append('file', new File([text], name));
      const encoded = new Response(form);
      const bytes = await encoded.arrayBuffer();
      return uploadRoute(
        new Request(url, { method: 'POST', body: bytes, headers: { Cookie: cookie, 'Content-Type': encoded.headers.get('Content-Type') ?? '', 'Content-Length': String(bytes.byteLength) } }),
        deps,
        id,
      );
    };
    const wrong = await send('счёт.pdf', 'не pdf');
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toMatch(/не похоже на \.pdf/);
    expect(await (await send('счёт.pdf', '%PDF-1.7 счёт')).text()).toMatch(/Файл «счёт\.pdf» приложен к карточке #600/);
    expect(fake.writes.map((w) => w.path)).toEqual([`/cards/${CARD_UID}/files`]);
    expect((await send('ещё.pdf', '%PDF-1.7')).status).toBe(410);
  });
});
