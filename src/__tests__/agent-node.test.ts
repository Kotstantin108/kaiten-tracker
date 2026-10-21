/**
 * Агентский сервер на своём хосте: KV на SQLite, переходник HTTP Node и
 * настройки. Сети нет: Kaiten — поддельный fetch, сервер — на случайном порту.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { sealToken } from '../agent-server/key.js';
import { createNodeHandler, readNodeConfig, sendResponse } from '../agent-server/node-http.js';
import { kvAsStore, SqliteKv } from '../agent-server/node-kv.js';

const SECRET = 'x'.repeat(40);
const PUBLIC = 'https://agent.example.com';

function kv(now: () => number = Date.now): SqliteKv {
  return new SqliteKv(new DatabaseSync(':memory:'), 'oauth', now);
}

describe('KV на SQLite', () => {
  it('текст и JSON; срок жизни — секунды от сейчас или момент; истёкшего не видно', async () => {
    let now = 1_000_000;
    const store = kv(() => now);
    await store.put('a', '{"x":1}', { expirationTtl: 60 });
    await store.put('b', 'текст', { expiration: now / 1000 + 120 });
    await store.put('c', 'навсегда');
    expect(await store.get('a', { type: 'json' })).toEqual({ x: 1 });
    expect(await store.get('b')).toBe('текст');
    now += 61_000;
    expect(await store.get('a')).toBeNull();
    expect((await store.list()).keys.map((k) => k.name)).toEqual(['b', 'c']);
    now += 60_000;
    expect(await store.get('b')).toBeNull();
    expect(store.purgeExpired()).toBe(2);
    expect(await store.get('c')).toBe('навсегда');
  });

  it('список: префикс, метаданные, страницы по курсору до list_complete', async () => {
    const store = kv();
    for (const id of ['3', '1', '2']) await store.put(`grant:alice:${id}`, '{}', { metadata: { id } });
    await store.put('grant:bob:1', '{}');
    await store.put('grantx', '{}');
    const first = await store.list({ prefix: 'grant:alice:', limit: 2 });
    expect(first).toEqual({ keys: [{ name: 'grant:alice:1', metadata: { id: '1' } }, { name: 'grant:alice:2', metadata: { id: '2' } }], list_complete: false, cursor: 'grant:alice:2' });
    const second = await store.list({ prefix: 'grant:alice:', limit: 2, cursor: first.cursor });
    expect(second).toEqual({ keys: [{ name: 'grant:alice:3', metadata: { id: '3' } }], list_complete: true });
    expect((await store.list({ prefix: 'grant:' })).keys.map((k) => k.name)).toEqual(['grant:alice:1', 'grant:alice:2', 'grant:alice:3', 'grant:bob:1']);
  });

  it('хранилище ядра: перезапись и удаление', async () => {
    const store = kvAsStore(kv());
    await store.put('pending:1', 'a', 60);
    await store.put('pending:1', 'b', 60);
    expect(await store.get('pending:1')).toBe('b');
    expect(await store.list('pending:')).toEqual(['pending:1']);
    await store.delete('pending:1');
    expect(await store.get('pending:1')).toBeNull();
  });
});

describe('настройки своего сервера', () => {
  it('всё на месте — запуск; не хватает — список без значений', () => {
    expect(readNodeConfig({ SERVER_SECRET: SECRET, KAITEN_DOMAIN: 'acme.kaiten.ru', PUBLIC_URL: `${PUBLIC}/` })).toEqual({
      secret: SECRET,
      domain: 'acme.kaiten.ru',
      publicUrl: PUBLIC,
      port: 8787,
      dataDir: '/data',
    });
    const bad = readNodeConfig({ SERVER_SECRET: 'short', PUBLIC_URL: 'http://agent.example.com/mcp' });
    expect(bad).toEqual({
      problems: [
        'SERVER_SECRET — не короче 32 символов',
        'KAITEN_DOMAIN — домен компании в Kaiten, например acme.kaiten.ru',
        'PUBLIC_URL — внешний адрес сервера по https без пути, например https://agent.example.com',
      ],
    });
    expect(JSON.stringify(bad)).not.toContain('short');
    expect('problems' in readNodeConfig({ SERVER_SECRET: SECRET, KAITEN_DOMAIN: 'acme.kaiten.ru', PUBLIC_URL: 'http://localhost:8787' })).toBe(false);
  });
});

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Поддельный Kaiten: имя пользователя — по токену из заголовка, ответ — с задержкой. */
const kaiten: typeof fetch = async (_input, init) => {
  const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? '';
  await new Promise((resolve) => setTimeout(resolve, token === 'token-alice' ? 30 : 0));
  return new Response(JSON.stringify({ id: token === 'token-alice' ? 1 : 2, full_name: token === 'token-alice' ? 'Alice' : 'Bob' }), { headers: { 'Content-Type': 'application/json' } });
};

describe('сервер на Node', () => {
  it('адрес — из PUBLIC_URL, а не из Host: OAuth отдаёт https-издателя', async () => {
    const base = await listen(createNodeHandler({ secret: SECRET, domain: 'acme.example.com', publicUrl: PUBLIC }, { oauthKv: kv(), store: kvAsStore(kv()), fetchImpl: kaiten }));
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as { issuer: string; client_id_metadata_document_supported: boolean };
    expect(meta.issuer).toBe(PUBLIC);
    // По адресу от клиента сервер не ходит: регистрация клиента — сама (DCR).
    expect(meta.client_id_metadata_document_supported).toBe(false);
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('два запроса одновременно с разными ключами — каждый от своего имени', async () => {
    const base = await listen(createNodeHandler({ secret: SECRET, domain: 'acme.example.com', publicUrl: PUBLIC }, { oauthKv: kv(), store: kvAsStore(kv()), fetchImpl: kaiten }));
    const whoami = async (token: string): Promise<string> => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await sealToken(token, SECRET)}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
      });
      return JSON.stringify(await response.json());
    };
    const [alice, bob] = await Promise.all([whoami('token-alice'), whoami('token-bob')]);
    expect(alice).toContain('Alice');
    expect(alice).not.toContain('Bob');
    expect(bob).toContain('Bob');
  });

  it('тело больше предела — 413: и по Content-Length, и потоком без него; сервер жив', async () => {
    const base = await listen(createNodeHandler({ secret: SECRET, domain: 'acme.example.com', publicUrl: PUBLIC }, { oauthKv: kv(), store: kvAsStore(kv()), fetchImpl: kaiten }, 1000));
    const big = 'token=' + 'a'.repeat(5000);
    expect((await fetch(`${base}/key`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: big })).status).toBe(413);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new TextEncoder().encode(i === 0 ? 'token=' : 'a'.repeat(1000)));
        controller.close();
      },
    });
    const streamed = await fetch(`${base}/key`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: chunked, duplex: 'half' } as RequestInit);
    expect(streamed.status).toBe(413);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('ответ: каждый Set-Cookie отдельно, тело потоком', async () => {
    const headers = new Headers({ 'Content-Type': 'text/event-stream' });
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/');
    let push: (text: string) => void = () => undefined;
    let close: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(new TextEncoder().encode(text));
        close = () => controller.close();
      },
    });
    const base = await listen((_req, res) => void sendResponse(res, new Response(body, { headers })));
    const response = await fetch(base);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    const reader = response.body?.getReader();
    push('event: one\n\n');
    // Первое событие приходит, пока поток ещё открыт.
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('event: one\n\n');
    close();
    expect((await reader?.read())?.done).toBe(true);
  });
});
