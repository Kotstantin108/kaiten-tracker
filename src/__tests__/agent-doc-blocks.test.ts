/**
 * Блоки в документах: встроенная страница, видео YouTube, картинка по ссылке
 * и файлом — на поддельном Kaiten, без сети.
 *
 * Проверяется то, что защищает страницы: блоки выключены, пока их не включат
 * правила папки; чужой домен, не-https и недопустимый файл — отказ до записи;
 * блок, вернувшийся без изменений, уходит в Kaiten тем же узлом; секрет из
 * ссылки (часть после #) не попадает в подтверждение; заслонка пускает в
 * документ только картинку по UUID.
 */
import { describe, expect, it } from 'vitest';

import { FolderRulesSchema, parsePage } from '../agent-server/doc-page.js';
import { allowedKinds, imageFileProblems } from '../agent-server/doc-blocks.js';
import { loadPending } from '../agent-server/docs.js';
import { checkKaitenCall } from '../agent-server/gate.js';
import { handleMcp } from '../agent-server/mcp.js';
import { markdownToNodes, nodesToMarkdown, type PMNode } from '../agent-server/prosemirror.js';
import { MemoryStore } from '../agent-server/store.js';

const SECRET = 'k'.repeat(40);
const DOMAIN = 'acme.example.com';
const SPACE_UID = '00000000-0000-4000-8000-000000000001';
const PLAIN = '00000000-0000-4000-8000-0000000000f1';
const CHARTS = '00000000-0000-4000-8000-0000000000f2';
const STRICT = '00000000-0000-4000-8000-0000000000f3';
const PAGE = '00000000-0000-4000-8000-0000000000d1';
const PLAIN_PAGE = '00000000-0000-4000-8000-0000000000d2';
const COMPANY = '00000000-0000-4000-8000-0000000000c0';

/** Ссылка с секретом в части после # — так выглядят живые графики. */
const CHART = 'https://charts.example.com/board/#key=SECRET-TOKEN-123';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const code = (yaml: string): PMNode => ({ type: 'code_block', attrs: { language: 'yaml' }, content: [{ type: 'text', text: yaml }] });
const doc = (content: PMNode[]): string => JSON.stringify({ type: 'doc', content });
const p = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h2 = (text: string): PMNode => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
const label = (name: string, value: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text: `${name}:`, marks: [{ type: 'strong' }] }, { type: 'text', text: ` ${value}` }] });
const header = (): PMNode[] => [label('Владелец', 'Alice'), label('Статус', 'Черновик'), label('Связано с', '—'), label('Обновлено', '2026-01-01, Alice')];
/** Блок, вставленный человеком: лишний атрибут сервер не знает, но обязан вернуть. */
const humanEmbed: PMNode = { type: 'embed', attrs: { src: CHART, size: 'large', extra: 'keep-me' } };

const CHART_RULES = [
  'version: 1',
  'title: "{Название}"',
  'levels:',
  '  append: free',
  '  replace: free',
  'blocks:',
  '  embed: true',
  '  video: true',
  '  images: true',
  '  domains: [charts.example.com, img.example.com]',
  '  level: free',
].join('\n');

interface FakeDoc {
  uid: string;
  title: string;
  parent_entity_uid: string;
  data: string;
  updated: string;
}

function fake() {
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> | FormData }> = [];
  let clock = 1;
  let nextFile = 0;
  const docs: FakeDoc[] = [
    { uid: '00000000-0000-4000-8000-0000000000a1', title: '⚙ Правила для агента', parent_entity_uid: PLAIN, updated: 't0', data: doc([code('version: 1\ntitle: "{Название}"\nlevels:\n  append: free\n  replace: free')]) },
    { uid: '00000000-0000-4000-8000-0000000000a2', title: '⚙ Правила для агента', parent_entity_uid: CHARTS, updated: 't0', data: doc([code(CHART_RULES)]) },
    {
      uid: '00000000-0000-4000-8000-0000000000a3',
      title: '⚙ Правила для агента',
      parent_entity_uid: STRICT,
      updated: 't0',
      data: doc([code('version: 1\ntitle: "{Название}"\nlevels:\n  append: free\n  replace: free\nblocks:\n  embed: true\n  domains: [charts.example.com]\n  level: confirm')]),
    },
    { uid: PAGE, title: 'Отчёт Acme', parent_entity_uid: CHARTS, updated: 't0', data: doc([...header(), h2('Графики'), p('было'), humanEmbed, h2('Цифры'), p('старые цифры'), h2('История изменений')]) },
    { uid: PLAIN_PAGE, title: 'Отчёт Globex', parent_entity_uid: PLAIN, updated: 't0', data: doc([...header(), h2('Графики'), p('было'), humanEmbed, h2('История изменений')]) },
  ];
  const groups = [
    { uid: PLAIN, title: 'Без блоков', entity_type: 'document_group', parent_entity_uid: SPACE_UID, sort_order: 1, has_children: true },
    { uid: CHARTS, title: 'Графики', entity_type: 'document_group', parent_entity_uid: SPACE_UID, sort_order: 2, has_children: true },
    { uid: STRICT, title: 'Строгая', entity_type: 'document_group', parent_entity_uid: SPACE_UID, sort_order: 3, has_children: true },
  ];
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/latest', '');
    const method = init?.method ?? 'GET';
    const body = init?.body instanceof FormData ? init.body : init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') writes.push({ method, path, body });
    if (method === 'GET' && path === '/users/current') return json({ id: 7, full_name: 'Alice', email: 'alice@example.com' });
    if (method === 'GET' && path === '/spaces') return json([{ id: 1, uid: SPACE_UID, title: 'Acme', boards: [] }]);
    if (method === 'GET' && path === '/card-types') return json([]);
    if (method === 'GET' && path === '/tree-entities') {
      const parent = url.searchParams.get('parent_entity_uid');
      return json([
        ...groups.filter((g) => g.parent_entity_uid === parent),
        ...docs.filter((d) => d.parent_entity_uid === parent).map((d) => ({ uid: d.uid, title: d.title, entity_type: 'document', parent_entity_uid: d.parent_entity_uid })),
      ]);
    }
    let m = /^\/document-groups\/(.+)$/.exec(path);
    if (method === 'GET' && m) {
      const g = groups.find((x) => x.uid === m?.[1]);
      return g ? json(g) : json({ message: 'нет' }, 404);
    }
    m = /^\/documents\/([^/]+)\/files$/.exec(path);
    if (method === 'POST' && m) {
      const id = `00000000-0000-4000-8000-0000000002${String(nextFile++).padStart(2, '0')}`;
      return json({ id, document_uid: m[1], url: `https://files/companies/${COMPANY}/documents/${m[1]}/${id}.png`, mime_type: 'image/png' });
    }
    m = /^\/documents\/([^/]+)$/.exec(path);
    if (m) {
      const d = docs.find((x) => x.uid === m?.[1]);
      if (!d) return json({ message: 'нет' }, 404);
      if (method === 'GET') return json(d);
      if (method === 'PATCH' && !(body instanceof FormData)) {
        if (body.data) d.data = JSON.stringify(body.data);
        d.updated = `t${clock++}`;
        return json(d);
      }
    }
    if (method === 'POST' && path === '/documents' && !(body instanceof FormData)) {
      const created: FakeDoc = { uid: `00000000-0000-4000-8000-0000000001${String(docs.length).padStart(2, '0')}`, title: String(body.title), parent_entity_uid: String(body.parent_entity_uid), data: doc([]), updated: 'new' };
      docs.push(created);
      return json(created);
    }
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

const nodesOf = (f: Fake, uid: string): PMNode[] => (JSON.parse(f.docs.find((d) => d.uid === uid)?.data ?? '{}') as { content: PMNode[] }).content;
const sectionOf = (f: Fake, uid: string, title: string): PMNode[] => parsePage(nodesOf(f, uid)).sections.find((s) => s.title === title)?.nodes ?? [];
const writeLog = (f: Fake): string[] => f.writes.map((w) => `${w.method} ${w.path}`);

describe('блоки ⇄ markdown', () => {
  it('строки блоков → узлы Kaiten', () => {
    const { nodes, problems } = markdownToNodes(`текст\n\n@[embed](${CHART})\n@[embed medium](https://charts.example.com/x)\n@[video](https://www.youtube.com/watch?v=abc)\n![](https://img.example.com/a.png)\n![подпись](file:график.png)`);
    expect(problems).toEqual([]);
    expect(nodes.slice(1)).toEqual([
      { type: 'embed', attrs: { src: CHART, size: 'large' } },
      { type: 'embed', attrs: { src: 'https://charts.example.com/x', size: 'medium' } },
      { type: 'embed', attrs: { src: 'https://www.youtube.com/watch?v=abc', size: 'medium' } },
      { type: 'image', attrs: { src: 'https://img.example.com/a.png', size: 'medium' } },
      { type: 'image', attrs: { src: 'file:график.png', size: 'medium' } },
    ]);
  });

  it('узлы → строки: вид блока, ссылка или файл; без разрешения папки — «с потерями»', () => {
    const nodes: PMNode[] = [
      humanEmbed,
      { type: 'embed', attrs: { src: 'https://www.youtube.com/watch?v=abc', size: 'medium' } },
      { type: 'image', attrs: { src: 'https://files/companies/c/documents/d/f.png', size: 'medium', fileId: 'f' } },
    ];
    const open = nodesToMarkdown(nodes, { blocks: allowedKinds({ embed: true, video: false, images: true, domains: [], level: 'free' }) });
    expect(open.markdown).toBe(`@[embed](${CHART})\n\n@[video](https://www.youtube.com/watch?v=abc)\n\n![](file:f)`);
    expect(open.lossy).toBe(false);
    expect(nodesToMarkdown(nodes).lossy).toBe(true);
    expect(nodesToMarkdown([humanEmbed], { blocks: allowedKinds({ embed: false, video: false, images: true, domains: [], level: 'free' }) }).lossy).toBe(true);
  });

  it('для подтверждений — только домен, без секрета', () => {
    const md = nodesToMarkdown([humanEmbed, { type: 'image', attrs: { src: 'https://img.example.com/a.png?sig=1', size: 'medium' } }], { redact: true }).markdown;
    expect(md).toBe('@[embed](https://charts.example.com/…)\n\n![](https://img.example.com/…)');
  });
});

describe('правила папки: ключ blocks', () => {
  const base = { version: 1, title: '{Название}' };

  it('нет ключа — блоков нет; ключ без значений — всё выключено, правка с подтверждением', () => {
    expect(FolderRulesSchema.parse(base).blocks).toBeUndefined();
    expect(FolderRulesSchema.parse({ ...base, blocks: {} }).blocks).toEqual({ embed: false, video: false, images: false, domains: [], level: 'confirm' });
  });

  it('домен — только имя; незнакомый ключ — ошибка (папка закроется)', () => {
    expect(FolderRulesSchema.parse({ ...base, blocks: { embed: true, domains: ['Charts.Example.com'] } }).blocks?.domains).toEqual(['charts.example.com']);
    expect(FolderRulesSchema.safeParse({ ...base, blocks: { domains: ['https://charts.example.com/x'] } }).success).toBe(false);
    expect(FolderRulesSchema.safeParse({ ...base, blocks: { iframe: true } }).success).toBe(false);
  });
});

describe('картинка файлом: тип по имени и по содержимому', () => {
  it('png с содержимым png — да; svg, «png» с чужим содержимым, пустой — нет', () => {
    expect(imageFileProblems('график.png', PNG)).toEqual([]);
    expect(imageFileProblems('схема.svg', new TextEncoder().encode('<svg/>')).join()).toMatch(/только картинки/);
    expect(imageFileProblems('график.png', new TextEncoder().encode('%PDF-1.7')).join()).toMatch(/не похоже на \.png/);
    expect(imageFileProblems('график.png', new Uint8Array()).join()).toMatch(/пустой/);
  });
});

describe('инструменты документов с блоками', () => {
  it('create_doc одним вызовом: встроенный блок, видео и картинка файлом', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', {
      folder: CHARTS,
      title: 'Отчёт · Acme',
      sections: { Графики: `Визиты по неделям.\n\n@[embed](${CHART})\n\n@[video](https://youtu.be/abc)\n\n![](file:график.png)` },
      files: [{ name: 'график.png', content_base64: b64(PNG) }],
      user_request: 'заведи страницу',
    });
    expect(reply.isError).toBe(false);
    expect(writeLog(f)).toEqual(['POST /documents', expect.stringMatching(/^POST \/documents\/[0-9a-f-]{36}\/files$/), expect.stringMatching(/^PATCH \/documents\//)]);
    const created = f.docs[f.docs.length - 1].uid;
    expect(sectionOf(f, created, 'Графики').slice(1)).toEqual([
      { type: 'embed', attrs: { src: CHART, size: 'large' } },
      { type: 'embed', attrs: { src: 'https://youtu.be/abc', size: 'medium' } },
      { type: 'image', attrs: { src: `https://files/companies/${COMPANY}/documents/${created}/00000000-0000-4000-8000-000000000200.png`, size: 'medium', fileId: '00000000-0000-4000-8000-000000000200' } },
    ]);
  });

  it('раздел из одного блока — не пустой', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', { folder: CHARTS, title: 'Только график', sections: { Графики: `@[embed](${CHART})` }, user_request: 'x' });
    expect(reply.isError).toBe(false);
  });

  it('папка без ключа blocks — как раньше: блок не создать, раздел с блоком не заменить', async () => {
    const f = fake();
    const created = await tool(f, 'create_doc', { folder: PLAIN, title: 'Страница', sections: { Графики: `@[embed](${CHART})` }, user_request: 'x' });
    expect(created.isError).toBe(true);
    expect(created.text).toMatch(/charts\.example\.com: в этой папке блоки не разрешены/);
    const replaced = await tool(f, 'replace_section', { doc: PLAIN_PAGE, section: 'Графики', text: 'новое', user_request: 'x' });
    expect(replaced.text).toMatch(/Раздел нельзя заменить целиком/);
    expect(f.writes).toEqual([]);
  });

  it('чужой домен, не https, логин в ссылке, похожий домен, порт — отказ до записи, в отказе только домен', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', {
      folder: CHARTS,
      title: 'Страница',
      sections: {
        Графики: [
          '@[embed](https://evil.example.org/#key=SECRET-TOKEN-123)',
          '@[embed](http://charts.example.com/x)',
          '@[embed](https://charts.example.com@evil.example.org/x)',
          '@[embed](https://evilcharts.example.com/x)',
          '@[embed](https://charts.example.com:8443/x)',
          '![](https://other.example.net/a.png)',
        ].join('\n'),
      },
      user_request: 'x',
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/встроенный блок с evil\.example\.org: домена нет в списке папки/);
    expect(reply.text).toMatch(/charts\.example\.com: только ссылки https/);
    expect(reply.text).toMatch(/evilcharts\.example\.com: домена нет/);
    expect(reply.text).toMatch(/с портом не принимается/);
    expect(reply.text).toMatch(/картинка по ссылке с other\.example\.net: домена нет/);
    expect(reply.text).not.toContain('SECRET-TOKEN');
    expect(f.writes).toEqual([]);
  });

  it('видео YouTube без video: true — отказ', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', { folder: STRICT, title: 'Страница', sections: { Видео: '@[video](https://www.youtube.com/watch?v=abc)' }, user_request: 'x' });
    expect(reply.text).toMatch(/видео в этой папке не разрешены/);
    expect(f.writes).toEqual([]);
  });

  it('недопустимый файл, файл без строки, строка без файла — отказ до создания страницы', async () => {
    const f = fake();
    const reply = await tool(f, 'create_doc', {
      folder: CHARTS,
      title: 'Страница',
      sections: { Графики: '![](file:схема.svg)\n\n![](file:нет.png)' },
      files: [
        { name: 'схема.svg', content_base64: b64(new TextEncoder().encode('<svg/>')) },
        { name: 'лишний.png', content_base64: b64(PNG) },
      ],
      user_request: 'x',
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/«схема\.svg»: в документ загружаются только картинки/);
    expect(reply.text).toMatch(/картинка «нет\.png»: такого файла нет/);
    expect(reply.text).toMatch(/файл «лишний\.png» передан, но на него нет строки/);
    expect(f.writes).toEqual([]);
  });

  it('read_doc показывает блок ссылкой; замена раздела, где блок не тронут, — узел возвращается со всеми атрибутами', async () => {
    const f = fake();
    const read = await tool(f, 'read_doc', { doc: PAGE });
    expect(read.text).toContain(`@[embed](${CHART})`);
    expect(read.text).not.toMatch(/можно только дописывать/);
    const reply = await tool(f, 'replace_section', { doc: PAGE, section: 'Графики', text: `стало\n\n@[embed](${CHART})`, user_request: 'обнови' });
    expect(reply.text).toMatch(/^Готово/);
    expect(sectionOf(f, PAGE, 'Графики')).toEqual([p('стало'), humanEmbed]);
  });

  it('замена другого раздела не трогает блок; размер блока можно поменять', async () => {
    const f = fake();
    await tool(f, 'replace_section', { doc: PAGE, section: 'Цифры', text: 'новые цифры', user_request: 'x' });
    expect(sectionOf(f, PAGE, 'Графики')).toEqual([p('было'), humanEmbed]);
    await tool(f, 'replace_section', { doc: PAGE, section: 'Графики', text: `@[embed medium](${CHART})`, user_request: 'x' });
    expect(sectionOf(f, PAGE, 'Графики')).toEqual([{ ...humanEmbed, attrs: { ...humanEmbed.attrs, size: 'medium' } }]);
  });

  it('новый блок при blocks.level: confirm — ссылка подтверждения, в ней только домен', async () => {
    const f = fake();
    const created = await tool(f, 'create_doc', { folder: STRICT, title: 'Строгая страница', sections: { Текст: 'текст' }, user_request: 'x' });
    expect(created.isError).toBe(false);
    const uid = f.docs[f.docs.length - 1].uid;
    const before = f.writes.length;
    const reply = await tool(f, 'append_to_section', { doc: uid, section: 'Текст', text: `@[embed](${CHART})`, user_request: 'добавь график' });
    expect(reply.text).toMatch(/НУЖНО ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА/);
    expect(f.writes.length).toBe(before);
    const pending = await loadPending(f.store, SECRET, /\/confirm\/([A-Za-z0-9_-]+)/.exec(reply.text)?.[1] ?? '');
    expect(pending?.after).toContain('@[embed](https://charts.example.com/…)');
    expect(`${pending?.after}${pending?.summary}`).not.toContain('SECRET-TOKEN');
    // Без нового блока та же папка дописывает сразу.
    expect((await tool(f, 'append_to_section', { doc: uid, section: 'Текст', text: 'ещё текст', user_request: 'x' })).text).toMatch(/^Готово/);
  });

  it('картинка в существующую страницу: загрузка, потом запись; прочитанная картинка возвращается тем же узлом', async () => {
    const f = fake();
    const reply = await tool(f, 'append_to_section', { doc: PAGE, section: 'Цифры', text: '![](file:график.png)', files: [{ name: 'график.png', content_base64: b64(PNG) }], user_request: 'x' });
    expect(reply.text).toMatch(/^Готово/);
    expect(writeLog(f)).toEqual([`POST /documents/${PAGE}/files`, `PATCH /documents/${PAGE}`]);
    const image = sectionOf(f, PAGE, 'Цифры')[1];
    expect(image).toMatchObject({ type: 'image', attrs: { fileId: '00000000-0000-4000-8000-000000000200' } });
    const read = await tool(f, 'read_doc', { doc: PAGE });
    expect(read.text).toContain('![](file:00000000-0000-4000-8000-000000000200)');
    await tool(f, 'replace_section', { doc: PAGE, section: 'Цифры', text: 'другие цифры\n\n![](file:00000000-0000-4000-8000-000000000200)', user_request: 'x' });
    expect(sectionOf(f, PAGE, 'Цифры')).toEqual([p('другие цифры'), image]);
    expect(f.writes.filter((w) => w.path.endsWith('/files'))).toHaveLength(1);
  });
});

describe('заслонка: файлы документа', () => {
  const DOC = '00000000-0000-4000-8000-0000000000d1';
  const FILE = '00000000-0000-4000-8000-0000000000e1';
  const form = (...files: Array<[string, string]>): FormData => {
    const f = new FormData();
    for (const [field, name] of files) f.append(field, new Blob([PNG], { type: 'image/png' }), name);
    return f;
  };

  it('одна картинка по UUID документа — да', () => {
    expect(checkKaitenCall('POST', `/documents/${DOC}/files`, form(['file', 'график.png']))).toBeNull();
  });

  it('не UUID, не картинка, два файла, JSON вместо формы — нет', () => {
    expect(checkKaitenCall('POST', '/documents/abc/files', form(['file', 'график.png']))).not.toBeNull();
    expect(checkKaitenCall('POST', `/documents/${DOC}/files`, form(['file', 'отчёт.pdf']))).toMatch(/только картинка/);
    expect(checkKaitenCall('POST', `/documents/${DOC}/files`, form(['file', 'a.png'], ['file', 'b.png']))).not.toBeNull();
    expect(checkKaitenCall('POST', `/documents/${DOC}/files`, JSON.stringify({ url: 'https://example.com/a.png' }))).toMatch(/только формой/);
  });

  it('переименовать и удалить файл документа — нельзя', () => {
    expect(checkKaitenCall('PATCH', `/documents/${DOC}/files/${FILE}`, JSON.stringify({ name: 'x.png' }))).not.toBeNull();
    expect(checkKaitenCall('DELETE', `/documents/${DOC}/files/${FILE}`)).not.toBeNull();
  });
});
