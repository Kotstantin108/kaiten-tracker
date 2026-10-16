/**
 * Режим «Документы» на поддельном Kaiten и хранилище в памяти.
 *
 * Проверяется то, что защищает документы: правила папки (шаблон названия,
 * разделы, связь), уровни (свободно / ссылка подтверждения), копия перед
 * каждой записью, отказ при чужой правке между чтением и записью,
 * неприкосновенность страницы правил и страниц, написанных людьми.
 */
import { describe, expect, it } from 'vitest';

import { addHistory, HISTORY, parsePage, renderPage } from '../agent-server/doc-page.js';
import { applyPending, loadPending } from '../agent-server/docs.js';
import { kaitenFor, handleMcp } from '../agent-server/mcp.js';
import { lineDiff } from '../agent-server/pages.js';
import { markdownToNodes, nodesToMarkdown, type PMNode } from '../agent-server/prosemirror.js';
import { checkCsrf, csrfToken, makeSession, readSession } from '../agent-server/session.js';
import { MemoryStore } from '../agent-server/store.js';

const SECRET = 'k'.repeat(40);
const DOMAIN = 'acme.example.com';
const SPACE_UID = '00000000-0000-4000-8000-000000000001';
const FOLDER = '00000000-0000-4000-8000-0000000000f1';
const OPEN_FOLDER = '00000000-0000-4000-8000-0000000000f2';
const RULES = '00000000-0000-4000-8000-0000000000a1';
const RULES2 = '00000000-0000-4000-8000-0000000000a2';
const HUMAN = '00000000-0000-4000-8000-0000000000d1';

const code = (yaml: string): PMNode => ({ type: 'code_block', attrs: { language: 'yaml' }, content: [{ type: 'text', text: yaml }] });
const doc = (content: PMNode[]): string => JSON.stringify({ type: 'doc', content });

interface FakeDoc {
  uid: string;
  title: string;
  parent_entity_uid: string;
  data: string;
  updated: string;
}

function fake() {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let clock = 1;
  const docs: FakeDoc[] = [
    {
      uid: RULES,
      title: '⚙ Правила для агента',
      parent_entity_uid: FOLDER,
      updated: 't0',
      data: doc([code('version: 1\ntitle: "АКТ — {Объект}"\nsections: [Объект, Результат]\nlink: Установка\nlevels:\n  append: free\n  replace: confirm')]),
    },
    {
      uid: RULES2,
      title: '⚙ Правила для агента',
      parent_entity_uid: OPEN_FOLDER,
      updated: 't0',
      data: doc([code('version: 1\ntitle: "{Название}"\nsections: []\nlevels:\n  append: free\n  replace: free')]),
    },
    { uid: HUMAN, title: 'Заметки людей', parent_entity_uid: OPEN_FOLDER, updated: 't0', data: doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Пишут люди' }] }]) },
  ];
  const groups = [
    { uid: FOLDER, title: 'Акты', entity_type: 'document_group', parent_entity_uid: SPACE_UID, sort_order: 1, has_children: true },
    { uid: OPEN_FOLDER, title: 'Черновики', entity_type: 'document_group', parent_entity_uid: SPACE_UID, sort_order: 2, has_children: true },
  ];
  const cards = [
    { id: 70, title: 'Globex · установка 1', board_id: 10, type_id: 200, column_id: 1, lane_id: 1, properties: {} },
    { id: 71, title: 'Globex — сделка', board_id: 10, type_id: 100, column_id: 1, lane_id: 1, properties: {} },
  ];
  let nextDoc = 0;
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/latest', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') writes.push({ method, path, body });
    if (method === 'GET' && path === '/users/current') return json({ id: 7, full_name: 'Alice', email: 'alice@example.com' });
    if (method === 'GET' && path === '/spaces') return json([{ id: 1, uid: SPACE_UID, title: 'Acme', boards: [{ id: 10 }] }]);
    if (method === 'GET' && path === '/card-types') return json([{ id: 100, name: 'Сделка' }, { id: 200, name: 'Установка' }]);
    if (method === 'GET' && path === '/tree-entities') {
      const parent = url.searchParams.get('parent_entity_uid');
      const nodes = [
        ...groups.filter((g) => g.parent_entity_uid === parent),
        ...docs.filter((d) => d.parent_entity_uid === parent).map((d) => ({ uid: d.uid, title: d.title, entity_type: 'document', parent_entity_uid: d.parent_entity_uid, has_children: false })),
      ];
      return json(nodes);
    }
    let m = /^\/document-groups\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      const g = groups.find((x) => x.uid === m?.[1]);
      return g ? json(g) : json({ message: 'нет' }, 404);
    }
    m = /^\/documents\/(.+)$/.exec(path);
    if (m) {
      const d = docs.find((x) => x.uid === m?.[1]);
      if (!d) return json({ message: 'нет' }, 404);
      if (method === 'GET') return json(d);
      if (method === 'PATCH') {
        if (body.data) d.data = JSON.stringify(body.data);
        if (typeof body.title === 'string') d.title = body.title;
        d.updated = `t${clock++}`;
        return json(d);
      }
    }
    if (method === 'GET' && path === '/documents') return json(docs.filter((d) => d.title.toLowerCase().includes((url.searchParams.get('query') ?? '').toLowerCase())));
    if (method === 'POST' && path === '/documents') {
      const created: FakeDoc = { uid: `00000000-0000-4000-8000-0000000001${String(nextDoc++).padStart(2, '0')}`, title: String(body.title), parent_entity_uid: String(body.parent_entity_uid), data: doc([]), updated: 'new' };
      docs.push(created);
      return json(created);
    }
    m = /^\/cards\/(\d+)$/.exec(path);
    if (method === 'GET' && m) {
      const c = cards.find((x) => x.id === Number(m?.[1]));
      return c ? json(c) : json({ message: 'нет' }, 404);
    }
    if (method === 'POST' && /^\/cards\/\d+\/external-links$/.test(path)) return json({});
    return json({ message: `нет маршрута ${method} ${path}` }, 404);
  };
  return { fetchImpl, writes, docs, store: new MemoryStore() };
}

type Fake = ReturnType<typeof fake>;

async function tool(f: Fake, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const request = new Request('https://agent.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const response = await handleMcp(request, { domain: DOMAIN, token: 't', secret: SECRET, fetchImpl: f.fetchImpl, store: f.store, publicUrl: 'https://agent.example.com', agentKey: 'kag1.test' });
  const body = (await response.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? 'нет ответа');
  return { text: body.result.content[0].text, isError: body.result.isError === true };
}

const ACT = {
  folder: FOLDER,
  title: 'АКТ — Globex, установка 1',
  sections: { Объект: 'Установка 1 на площадке **Globex**.', Результат: '- замер в норме\n- акт подписан' },
  links: [70],
  user_request: 'оформи акт по Globex',
};

describe('markdown ⇄ ProseMirror', () => {
  it('блоки и отметки — туда и обратно', () => {
    const md = 'Абзац с **жирным**, *курсивом*, `кодом` и [ссылкой](https://example.com).\n\n### Подзаголовок\n\n- раз\n- два\n\n1. первый\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```yaml\nx: 1\n```';
    const { nodes, problems } = markdownToNodes(md);
    expect(problems).toEqual([]);
    expect(nodes.map((n) => n.type)).toEqual(['paragraph', 'heading', 'bullet_list', 'ordered_list', 'table', 'code_block']);
    const back = nodesToMarkdown(nodes);
    expect(back.lossy).toBe(false);
    expect(back.markdown).toContain('**жирным**');
    expect(back.markdown).toContain('| 1 | 2 |');
  });

  it('## внутри раздела запрещён: это граница разделов', () => {
    expect(markdownToNodes('## Новый раздел\nтекст').problems.join()).toMatch(/можно только ###/);
  });

  it('чек-лист и картинка — «с потерями»', () => {
    const back = nodesToMarkdown([{ type: 'check_list', content: [{ type: 'check_list_item', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'готово' }] }] }] }, { type: 'image' }]);
    expect(back.lossy).toBe(true);
    expect(back.markdown).toContain('- [x] готово');
  });
});

describe('страница: шапка и история', () => {
  it('шапка, разделы и история — туда и обратно; история всегда последняя', () => {
    const page = { header: { owner: 'Alice', status: 'Черновик' as const, links: [{ title: '#70', url: 'https://x/70' }], updated: '2026-01-01, Alice' }, preamble: [], sections: [{ title: HISTORY, nodes: [] }, { title: 'Объект', nodes: markdownToNodes('текст').nodes }] };
    addHistory(page, 'создана');
    const parsed = parsePage(renderPage(page));
    expect(parsed.header).toMatchObject({ owner: 'Alice', status: 'Черновик', links: [{ title: '#70', url: 'https://x/70' }] });
    expect(parsed.sections.map((s) => s.title)).toEqual(['Объект', HISTORY]);
  });

  it('страница без шапки — шапки нет (написана человеком)', () => {
    expect(parsePage(markdownToNodes('**Владелец:** кто-то\n\nтекст').nodes).header).toBeNull();
  });
});

describe('сессия и разница', () => {
  it('сессия подписана и истекает; CSRF привязан к сессии и подтверждению', async () => {
    const value = await makeSession(7, SECRET, 1000);
    expect(await readSession(value, SECRET, 2000)).toEqual({ userId: 7 });
    expect(await readSession(value.replace(/^7/, '8'), SECRET, 2000)).toBeNull();
    expect(await readSession(value, SECRET, 1000 + 31 * 86400 * 1000)).toBeNull();
    const token = await csrfToken(value, 'p1', SECRET);
    expect(await checkCsrf(value, 'p1', token, SECRET)).toBe(true);
    expect(await checkCsrf(value, 'p2', token, SECRET)).toBe(false);
  });

  it('построчная разница', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc').map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'add:x', 'del:b', 'same:c']);
  });
});

describe('инструменты документов', () => {
  it('дерево: страница правил скрыта, правила папки видны', async () => {
    const reply = await tool(fake(), 'list_docs', { space_id: 1 });
    expect(reply.text).toMatch(/📁 Акты .* название «АКТ — \{Объект\}»; разделы: Объект, Результат; связь с карточкой: обязательна \(Установка\)/);
    expect(reply.text).not.toContain('Правила для агента');
  });

  it('создание — всё не так: один отказ со списком, ничего не записано', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', { folder: FOLDER, title: 'Акт Globex', sections: { Объект: '   ', Лишний: 'x', [HISTORY]: 'подделка' }, links: [71], user_request: 'x' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/шаблону «АКТ — \{Объект\}»/);
    expect(reply.text).toMatch(/раздел «Объект» пустой/);
    expect(reply.text).toMatch(/нет раздела «Результат»/);
    expect(reply.text).toMatch(/История изменений» ведёт сервер/);
    expect(reply.text).toMatch(/#71 — «Сделка», а связывать .* Установка/);
    expect(f.writes).toEqual([]);
  });

  it('создание по правилам: папка-родитель, шапка, разделы, история, ссылка в карточке', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', ACT);
    expect(reply.isError).toBe(false);
    expect(f.writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /documents', expect.stringMatching(/^PATCH \/documents\//), 'POST /cards/70/external-links']);
    expect(f.writes[0].body).toMatchObject({ parent_entity_uid: FOLDER, title: ACT.title });
    const created = f.docs[f.docs.length - 1];
    const page = parsePage(JSON.parse(created.data).content as PMNode[]);
    expect(page.header).toMatchObject({ owner: 'Alice', status: 'Черновик' });
    expect(page.sections.map((s) => s.title)).toEqual(['Объект', 'Результат', HISTORY]);
    expect(nodesToMarkdown(page.sections[2].nodes).markdown).toMatch(/создана ИИ-агентом по просьбе «оформи акт по Globex»/);
    const twin = await tool(f, 'create_doc', ACT);
    expect(twin.text).toMatch(/в папке уже есть/);
  });

  it('дописать (свободно) — сразу, с копией перед записью', async () => {
    const f = fake();
    await tool(f, 'create_doc', ACT);
    const uid = f.docs[f.docs.length - 1].uid;
    const reply = await tool(f, 'append_to_section', { doc: uid, section: 'Результат', text: 'дополнение', user_request: 'допиши' });
    expect(reply.text).toMatch(/^Готово/);
    expect((await f.store.list(`snap:${uid}:`)).length).toBe(1);
    expect(f.docs.find((d) => d.uid === uid)?.data).toContain('дополнение');
  });

  it('заменить (с подтверждением) — ссылка, ничего не записано; применение по ссылке пишет', async () => {
    const f = fake();
    await tool(f, 'create_doc', ACT);
    const uid = f.docs[f.docs.length - 1].uid;
    const before = f.writes.length;
    const reply = await tool(f, 'replace_section', { doc: uid, section: 'Объект', text: 'новый объект', user_request: 'замени' });
    expect(reply.text).toMatch(/НУЖНО ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА/);
    expect(f.writes.length).toBe(before);
    const id = /\/confirm\/([A-Za-z0-9_-]+)/.exec(reply.text)?.[1] ?? '';
    const pending = await loadPending(f.store, SECRET, id);
    expect(pending).toMatchObject({ userId: 7, agentKey: 'kag1.test' });
    expect(pending?.after).toContain('новый объект');
    const kaiten = kaitenFor({ domain: DOMAIN, token: 't', secret: SECRET, fetchImpl: f.fetchImpl });
    const result = await applyPending({ kaiten, store: f.store, secret: SECRET, domain: DOMAIN }, pending!);
    expect(result).toMatch(/^Применено/);
    expect(f.docs.find((d) => d.uid === uid)?.data).toContain('новый объект');
  });

  it('страницу правили между чтением и записью — отказ, не перезаписываем', async () => {
    const f = fake();
    await tool(f, 'create_doc', ACT);
    const target = f.docs[f.docs.length - 1];
    const reply = await tool(f, 'set_doc_status', { doc: target.uid, status: 'Действует', user_request: 'утверди' });
    const pending = await loadPending(f.store, SECRET, /\/confirm\/([A-Za-z0-9_-]+)/.exec(reply.text)?.[1] ?? '');
    target.updated = 'изменено человеком';
    const kaiten = kaitenFor({ domain: DOMAIN, token: 't', secret: SECRET, fetchImpl: f.fetchImpl });
    expect(await applyPending({ kaiten, store: f.store, secret: SECRET, domain: DOMAIN }, pending!)).toMatch(/изменилась после того/);
  });

  it('страница правил агенту не даётся', async () => {
    const f = fake();
    expect((await tool(f, 'read_doc', { doc: RULES })).text).toMatch(/служебная страница/);
    expect((await tool(f, 'create_doc', { folder: OPEN_FOLDER, title: 'Правила для агента', sections: { Текст: 'x' }, user_request: 'x' })).text).toMatch(/служебной страницы/);
    expect(f.writes).toEqual([]);
  });

  it('страница человека: первая правка — только с подтверждением; его текст остаётся как был', async () => {
    const f = fake();
    expect((await tool(f, 'read_doc', { doc: HUMAN })).text).toMatch(/первая правка агента — только с подтверждением/);
    const reply = await tool(f, 'append_to_section', { doc: HUMAN, section: 'Итоги', text: 'дописал агент', user_request: 'допиши итоги' });
    expect(reply.text).toMatch(/НУЖНО ПОДТВЕРЖДЕНИЕ.*впервые добавит шапку/s);
    expect(f.writes).toEqual([]);
    const pending = await loadPending(f.store, SECRET, /\/confirm\/([A-Za-z0-9_-]+)/.exec(reply.text)?.[1] ?? '');
    const page = parsePage(pending?.plan.content as PMNode[]);
    expect(page.header).toMatchObject({ owner: 'Alice', status: 'Черновик' });
    expect(nodesToMarkdown(page.preamble).markdown).toBe('Пишут люди');
    expect(page.sections.map((s) => s.title)).toEqual(['Итоги', HISTORY]);
  });

  it('версии и откат — только через подтверждение', async () => {
    const f = fake();
    await tool(f, 'create_doc', ACT);
    const uid = f.docs[f.docs.length - 1].uid;
    await tool(f, 'append_to_section', { doc: uid, section: 'Результат', text: 'лишнее', user_request: 'x' });
    const versions = await tool(f, 'doc_versions', { doc: uid });
    const version = /^(\d+) —/m.exec(versions.text)?.[1];
    expect(version).toBeDefined();
    const writes = f.writes.length;
    const rollback = await tool(f, 'rollback_doc', { doc: uid, version, user_request: 'верни' });
    expect(rollback.text).toMatch(/НУЖНО ПОДТВЕРЖДЕНИЕ/);
    expect(f.writes.length).toBe(writes);
    const pending = await loadPending(f.store, SECRET, /\/confirm\/([A-Za-z0-9_-]+)/.exec(rollback.text)?.[1] ?? '');
    expect(pending?.after).not.toContain('лишнее');
  });
});
