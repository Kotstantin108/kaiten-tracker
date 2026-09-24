/**
 * Клиент yonote на поддельном fetch: ни одного сетевого вызова.
 *
 * Проверяется то, что испортит выгрузку незаметно: пагинация (потерянная
 * страница = потерянные документы, которые после выключения не вернуть),
 * ретраи и — отдельно — что токен не уходит в хранилище при редиректе
 * вложения.
 */
import { describe, expect, it, vi } from 'vitest';

import { YonoteApiError, YonoteClient } from '../yonote-client.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Spec = { status?: number; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> };

function makeClient(responses: Spec[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const spec = responses[Math.min(index++, responses.length - 1)];
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const payload = spec.raw ?? (spec.body === undefined ? null : JSON.stringify(spec.body));
    return new Response(payload, {
      status: spec.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(spec.headers ?? {}) },
    });
  });
  const sleeps: number[] = [];
  const client = new YonoteClient({
    baseUrl: 'team.yonote.ru',
    token: 'secret-token',
    fetchImpl: impl as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

const doc = (i: number) => ({ id: `id-${i}`, title: `Документ ${i}` });

describe('YonoteClient.listAll', () => {
  it('POST на /api/<метод> с Bearer и идёт по страницам, пока страница полная', async () => {
    const page = (from: number, n: number) => ({ ok: true, data: Array.from({ length: n }, (_, i) => doc(from + i)) });
    const { client, calls } = makeClient([{ body: page(0, 100) }, { body: page(100, 3) }]);

    const docs = await client.documents('documents.list');

    expect(docs).toHaveLength(103);
    expect(calls.map((c) => c.url)).toEqual(['https://team.yonote.ru/api/documents.list', 'https://team.yonote.ru/api/documents.list']);
    expect(calls.map((c) => c.body)).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
  });

  it('передаёт тело метода и сохраняет незнакомые поля', async () => {
    const { client, calls } = makeClient([{ body: { data: [{ ...doc(1), yonoteOnly: 42 }] } }]);
    const docs = await client.documents('documents.list', { template: true });
    expect(calls[0].body).toEqual({ template: true, limit: 100, offset: 0 });
    expect(docs[0]).toMatchObject({ id: 'id-1', yonoteOnly: 42 });
  });

  it('повторяет 429 с паузой из Retry-After', async () => {
    const { client, sleeps } = makeClient([{ status: 429, headers: { 'Retry-After': '2' } }, { body: { data: [doc(1)] } }]);
    expect(await client.documents('documents.drafts')).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it('4xx — ошибка со статусом, без токена в сообщении', async () => {
    const { client } = makeClient([{ status: 404, body: { ok: false, error: 'not_found' } }]);
    const error = await client.documents('documents.deleted').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YonoteApiError);
    expect((error as YonoteApiError).status).toBe(404);
    expect(String((error as Error).message)).not.toContain('secret-token');
  });
});

describe('YonoteClient.comments', () => {
  it('спрашивает entityId и читает data.comments — форма yonote, не Outline', async () => {
    const { client, calls } = makeClient([{ body: { ok: true, data: { comments: [{ id: 'c1' }] }, total: 1 } }]);
    expect(await client.comments('doc-1')).toEqual([{ id: 'c1' }]);
    expect(calls[0].url).toBe('https://team.yonote.ru/api/comments.list');
    expect(calls[0].body).toEqual({ entityId: 'doc-1', limit: 100, offset: 0 });
  });
});

describe('YonoteClient.downloadAttachment', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('не несёт токен в чужое хранилище при редиректе', async () => {
    const { client, calls } = makeClient([
      { status: 302, headers: { Location: 'https://storage.example.net/bucket/a.png?sig=x' } },
      { raw: bytes, headers: { 'Content-Type': 'image/png' } },
    ]);

    const file = await client.downloadAttachment('att-1');

    expect(file.contentType).toBe('image/png');
    expect([...file.bytes]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe('https://team.yonote.ru/api/attachments.redirect?id=att-1');
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
    expect(calls[1].url).toBe('https://storage.example.net/bucket/a.png?sig=x');
    expect(calls[1].headers.Authorization).toBeUndefined();
  });

  it('относительный редирект — на свой хост, с токеном', async () => {
    const { client, calls } = makeClient([
      { status: 302, headers: { Location: '/api/files.get?key=k&sig=s' } },
      { raw: bytes, headers: { 'Content-Type': 'application/pdf' } },
    ]);
    await client.downloadAttachment('att-2');
    expect(calls[1].url).toBe('https://team.yonote.ru/api/files.get?key=k&sig=s');
    expect(calls[1].headers.Authorization).toBe('Bearer secret-token');
  });

  it('бесконечные редиректы обрываются', async () => {
    const { client } = makeClient([{ status: 302, headers: { Location: '/loop' } }]);
    await expect(client.downloadAttachment('att-3')).rejects.toThrow(/редирект/);
  });
});
