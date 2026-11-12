/**
 * Поддельный Kaiten в памяти для тестов синхронизации: ни одного сетевого
 * вызова. Повторяет то, что проверено живьём: список карточек без описания и
 * пунктов чек-листов (они — только в `GET /cards/{id}`), свойства — `id_<поле>`,
 * выбор — массив id, ограничение доски «без «Сути» не создать» — 400 с
 * `error_text`. Пути связи и пунктов проверены живьём 29.09, комментариев —
 * по документации.
 */

import { KaitenClient } from '../kaiten-client.js';

export interface FakeItem {
  id: number;
  text: string;
  checked: boolean;
  sort_order?: number;
}

export interface FakeChecklist {
  id: number;
  name: string;
  items: FakeItem[];
}

/** Файл карточки с ограниченным доступом: id — UUID, размер строкой (живьём 16.10). */
export interface FakeFile {
  id: string;
  name: string;
  content: Uint8Array;
}

export interface FakeCard {
  id: number;
  uid?: string;
  files?: FakeFile[];
  title: string;
  board_id: number;
  column_id?: number;
  lane_id?: number;
  type_id?: number;
  external_id: string | null;
  description: string;
  properties: Record<string, unknown>;
  parents_ids: number[] | null;
  checklists: FakeChecklist[];
  comments: string[];
  archived: boolean;
  /** Как живьём 29.09: дата создания и автор есть и в списке, и в карточке. */
  created?: string;
  owner?: { email: string | null; full_name: string | null };
  column_changed_at?: string;
  text_format_type_id?: number;
}

export interface FakeKaiten {
  client: KaitenClient;
  cards: Map<number, FakeCard>;
  /** Запросы, меняющие данные: `POST /cards`, `PATCH /cards/1`… */
  writes: string[];
  /** Поле «Суть», без которого карточку не создать (ограничение доски). */
  requiredSummaryKey: string | null;
  failOn?: (method: string, path: string) => { status: number; body: unknown } | null;
  /** Запросы файлов по числовому id карточки — так Kaiten молча делает файл публичным. */
  numericFileRequests: string[];
  /** Заголовки скачиваний по подписанной ссылке — токена там быть не должно. */
  signedFetches: Array<Record<string, string>>;
}

const SIGNED_HOST = 'https://files.example.com/';

function fakeUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function fakeKaiten(options: { requiredSummaryKey?: string | null; firstId?: number } = {}): FakeKaiten {
  let nextId = options.firstId ?? 900_000;
  const fake: FakeKaiten = {
    cards: new Map(),
    writes: [],
    requiredSummaryKey: options.requiredSummaryKey ?? null,
    client: undefined as unknown as KaitenClient,
    numericFileRequests: [],
    signedFetches: [],
  };

  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fileView = (f: FakeFile, card: FakeCard): Record<string, unknown> => ({ id: f.id, name: f.name, size: String(f.content.length), type: 11, card_id: card.id });
  const cardView = (c: FakeCard): Record<string, unknown> => {
    const { files, ...rest } = c;
    return { ...rest, files: (files ?? []).map((f) => fileView(f, c)) };
  };
  const listView = (c: FakeCard): Record<string, unknown> => {
    const { description: _d, checklists, comments: _c, files: _f, ...rest } = c;
    return { ...rest, checklists: checklists.map(({ items: _i, ...l }) => l) };
  };
  const findChecklist = (id: number): FakeChecklist | undefined => [...fake.cards.values()].flatMap((c) => c.checklists).find((l) => l.id === id);
  const byUid = (uid: string): FakeCard | undefined => [...fake.cards.values()].find((c) => c.uid === uid);

  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const raw = String(input);
    if (raw.startsWith(SIGNED_HOST)) {
      fake.signedFetches.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const file = [...fake.cards.values()].flatMap((c) => c.files ?? []).find((f) => f.id === raw.slice(SIGNED_HOST.length));
      return file ? new Response(new Uint8Array(file.content), { status: 200 }) : new Response('', { status: 404 });
    }
    const url = new URL(raw);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/latest/, '');
    const form = init?.body instanceof FormData ? init.body : null;
    const body = (init?.body && !form ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    if (method !== 'GET') fake.writes.push(`${method} ${path}`);
    const failure = fake.failOn?.(method, path);
    if (failure) return json(failure.status, failure.body);

    let m: RegExpExecArray | null;
    // Файлы карточки — по UUID (живьём 16.10); по числу — нарушение, а не маршрут.
    if (/^\/cards\/\d+\/files/.test(path)) {
      fake.numericFileRequests.push(`${method} ${path}`);
      return json(400, { message: 'файлы — только по UUID' });
    }
    if (method === 'POST' && (m = /^\/cards\/([0-9a-f-]{36})\/files$/.exec(path))) {
      const card = byUid(m[1]);
      const file = form?.get('file');
      if (!card || !(file instanceof Blob)) return json(400, {});
      // Как живьём: путь в имени сервер отрезает.
      const name = ((file as File).name ?? '').split('/').at(-1) ?? '';
      const created: FakeFile = { id: fakeUuid(nextId++), name, content: new Uint8Array(await file.arrayBuffer()) };
      card.files = [...(card.files ?? []), created];
      return json(200, fileView(created, card));
    }
    if ((m = /^\/cards\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/.exec(path))) {
      const card = byUid(m[1]);
      const file = card?.files?.find((f) => f.id === m?.[2]);
      if (!card || !file) return json(404, {});
      if (method === 'GET') return json(200, { ...fileView(file, card), url: `${SIGNED_HOST}${file.id}` });
      if (method === 'PATCH') {
        if (typeof body.name === 'string') file.name = body.name;
        return json(200, fileView(file, card));
      }
      if (method === 'DELETE') {
        card.files = (card.files ?? []).filter((f) => f !== file);
        return json(200, { id: file.id });
      }
    }
    if (method === 'GET' && path === '/cards') {
      const board = url.searchParams.get('board_id');
      const ext = url.searchParams.get('external_id');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      // Как живьём (23.09): список доски и фильтр по external_id отдают и архивные карточки.
      const all = [...fake.cards.values()].filter((c) => (!board || c.board_id === Number(board)) && (!ext || c.external_id === ext));
      return json(200, all.slice(offset, offset + limit).map(listView));
    }
    if ((m = /^\/cards\/(\d+)$/.exec(path))) {
      const card = fake.cards.get(Number(m[1]));
      if (!card) return json(404, { message: 'not found' });
      if (method === 'GET') return json(200, cardView(card));
      if (method === 'PATCH') {
        const { properties, condition, ...rest } = body;
        Object.assign(card, rest);
        if (properties) card.properties = { ...card.properties, ...(properties as Record<string, unknown>) };
        // Как живьём (19.10): condition 2 — архив, 1 — на доске; колонка и дорожка не меняются.
        if (condition !== undefined) card.archived = condition === 2;
        return json(200, cardView(card));
      }
    }
    if (method === 'POST' && path === '/cards') {
      const props = (body.properties ?? {}) as Record<string, unknown>;
      if (fake.requiredSummaryKey && !props[fake.requiredSummaryKey]) return json(400, { error_text: 'Нельзя создать карточку без «Сути»' });
      const id = nextId++;
      const card: FakeCard = {
        id,
        uid: fakeUuid(id),
        title: String(body.title),
        board_id: Number(body.board_id),
        column_id: body.column_id as number | undefined,
        lane_id: body.lane_id as number | undefined,
        type_id: body.type_id as number | undefined,
        external_id: (body.external_id as string | undefined) ?? null,
        description: String(body.description ?? ''),
        properties: props,
        parents_ids: null,
        checklists: [],
        comments: [],
        archived: false,
        created: '2026-09-28T10:00:00.000Z',
      };
      fake.cards.set(card.id, card);
      return json(200, cardView(card));
    }
    if (method === 'POST' && (m = /^\/cards\/(\d+)\/children$/.exec(path))) {
      const child = fake.cards.get(Number(body.card_id));
      if (!child) return json(404, {});
      child.parents_ids = [...(child.parents_ids ?? []), Number(m[1])];
      return json(200, {});
    }
    if (method === 'DELETE' && (m = /^\/cards\/(\d+)\/children\/(\d+)$/.exec(path))) {
      const child = fake.cards.get(Number(m[2]));
      const parent = Number(m[1]);
      if (!child) return json(404, {});
      // Повтор для уже снятой связи живой Kaiten тоже принимает (docs/kaiten-api.md).
      const left = (child.parents_ids ?? []).filter((p) => p !== parent);
      child.parents_ids = left.length > 0 ? left : null;
      return json(200, { id: child.id });
    }
    if (method === 'POST' && (m = /^\/cards\/(\d+)\/checklists$/.exec(path))) {
      const list: FakeChecklist = { id: nextId++, name: String(body.name), items: [] };
      fake.cards.get(Number(m[1]))?.checklists.push(list);
      return json(200, { id: list.id, name: list.name });
    }
    if (method === 'POST' && (m = /^\/checklists\/(\d+)\/items$/.exec(path))) {
      findChecklist(Number(m[1]))?.items.push({ id: nextId++, text: String(body.text), checked: Boolean(body.checked), sort_order: body.sort_order as number | undefined });
      return json(200, {});
    }
    if (method === 'PATCH' && (m = /^\/cards\/\d+\/checklists\/(\d+)\/items\/(\d+)$/.exec(path))) {
      const [, listId, itemId] = m;
      const item = findChecklist(Number(listId))?.items.find((i) => i.id === Number(itemId));
      if (!item) return json(404, {});
      if (body.checked !== undefined) item.checked = Boolean(body.checked);
      if (body.text !== undefined) item.text = String(body.text);
      if (body.sort_order !== undefined) item.sort_order = Number(body.sort_order);
      return json(200, item);
    }
    // Удаление пункта и чек-листа — как живьём 16.10: ответ `{id}`.
    if (method === 'DELETE' && (m = /^\/cards\/(\d+)\/checklists\/(\d+)\/items\/(\d+)$/.exec(path))) {
      const list = fake.cards.get(Number(m[1]))?.checklists.find((l) => l.id === Number(m?.[2]));
      const index = list?.items.findIndex((i) => i.id === Number(m?.[3])) ?? -1;
      if (!list || index === -1) return json(404, {});
      list.items.splice(index, 1);
      return json(200, { id: Number(m[3]) });
    }
    if (method === 'DELETE' && (m = /^\/cards\/(\d+)\/checklists\/(\d+)$/.exec(path))) {
      const card = fake.cards.get(Number(m[1]));
      const index = card?.checklists.findIndex((l) => l.id === Number(m?.[2])) ?? -1;
      if (!card || index === -1) return json(404, {});
      card.checklists.splice(index, 1);
      return json(200, { id: Number(m[2]) });
    }
    if (method === 'POST' && (m = /^\/cards\/(\d+)\/comments$/.exec(path))) {
      fake.cards.get(Number(m[1]))?.comments.push(String(body.text));
      return json(200, {});
    }
    return json(404, { message: `нет маршрута ${method} ${path}` });
  };

  fake.client = new KaitenClient({ domain: 'test.kaiten.ru', token: 'secret-token', fetchImpl: impl as typeof fetch, sleep: async () => {}, maxRetries: 0 });
  return fake;
}

/** Карточка, заведённая «руками» (пилот, интерфейс Kaiten). */
export function seedCard(fake: FakeKaiten, card: Partial<FakeCard> & { id: number; title: string; board_id: number }): FakeCard {
  const full: FakeCard = {
    external_id: null,
    description: '',
    properties: {},
    parents_ids: null,
    checklists: [],
    comments: [],
    archived: false,
    uid: fakeUuid(card.id),
    ...card,
  };
  fake.cards.set(full.id, full);
  return full;
}
