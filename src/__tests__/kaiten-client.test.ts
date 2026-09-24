/**
 * Тесты клиента Kaiten на поддельном fetch: ни одного сетевого вызова.
 *
 * Проверяется ровно то, что способно испортить заливку молча: пагинация по 100
 * (максимум API), поведение на 429 и на исчерпанный лимит, и — главное —
 * перепроверка `external_id` на клиенте. Точность серверного фильтра не
 * задокументирована: если он ищет подстрокой, идемпотентность сломается и
 * вместо обновления появится дубль.
 */
import { describe, expect, it, vi } from 'vitest';

import { KaitenApiError, KaitenClient } from '../kaiten-client.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
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
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(spec.headers ?? {}) },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const card = (id: number, externalId: string | null) => ({ id, title: `card ${id}`, external_id: externalId });

function makeClient(responses: Parameters<typeof stubFetch>[0]) {
  const { impl, calls } = stubFetch(responses);
  const sleeps: number[] = [];
  const client = new KaitenClient({
    domain: 'acme.kaiten.ru',
    token: 'secret-token',
    fetchImpl: impl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

describe('KaitenClient.listCards', () => {
  it('идёт по страницам, пока страница полная', async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => card(from + i, `ext-${from + i}`));
    const { client, calls } = makeClient([{ body: page(0, 100) }, { body: page(100, 100) }, { body: page(200, 50) }]);

    const cards = await client.listCards({ boardId: 7 });

    expect(cards).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('limit=100');
    expect(calls[1].url).toContain('offset=100');
    expect(calls[2].url).toContain('offset=200');
  });

  it('шлёт Bearer в заголовке и не кладёт токен в URL', async () => {
    const { client, calls } = makeClient([{ body: [] }]);
    await client.listCards({ boardId: 7 });
    expect(calls[0].headers.Authorization).toBe('Bearer secret-token');
    expect(calls[0].url).not.toContain('secret-token');
  });
});

describe('KaitenClient.findCardByExternalId', () => {
  it('отбрасывает частичные совпадения, если фильтр окажется подстрочным', async () => {
    const { client } = makeClient([{ body: [card(1, '20260916_export-csv-old'), card(2, '20260916_export-csv')] }]);
    const found = await client.findCardByExternalId('20260916_export-csv', 7);
    expect(found?.id).toBe(2);
  });

  it('карточек с тем же external_id не должно быть двух — это сломанная идемпотентность', async () => {
    const { client } = makeClient([{ body: [card(1, '20260916_x'), card(2, '20260916_x')] }]);
    await expect(client.findCardByExternalId('20260916_x', 7)).rejects.toBeInstanceOf(KaitenApiError);
  });

  it('пусто — значит карточки нет, а не «возьмём первую похожую»', async () => {
    const { client } = makeClient([{ body: [card(1, 'совсем-другое')] }]);
    expect(await client.findCardByExternalId('20260916_x', 7)).toBeNull();
  });
});

describe('лимиты и ошибки', () => {
  it('повторяет 429 и уважает Retry-After', async () => {
    const { client, sleeps, calls } = makeClient([
      { status: 429, body: {}, headers: { 'Retry-After': '2' } },
      { body: [] },
    ]);
    await client.listCards({ boardId: 7 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('ждёт окна, когда остаток лимита исчерпан', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3;
    const { client, sleeps } = makeClient([{ body: [], headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) } }]);
    await client.listCards({ boardId: 7 });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it('4xx не повторяет, а падает с телом ответа', async () => {
    const { client, calls } = makeClient([{ status: 422, body: { error: 'board_id required' } }]);
    await expect(client.createCard({ title: 'x', board_id: 7 })).rejects.toBeInstanceOf(KaitenApiError);
    expect(calls).toHaveLength(1);
  });
});

describe('KaitenClient.createCard', () => {
  it('всегда шлёт markdown-формат описания', async () => {
    const { client, calls } = makeClient([{ body: card(10, '20260916_x') }]);
    await client.createCard({ title: 'Задача', board_id: 7, external_id: '20260916_x', description: '- [ ] пункт' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ text_format_type_id: 1, external_id: '20260916_x' });
  });
});

describe('KaitenClient: сетевой обрыв', () => {
  const flaky = (failures: number) => {
    let n = 0;
    const impl = vi.fn(async (): Promise<Response> => {
      if (n++ < failures) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const client = new KaitenClient({ domain: 'x.kaiten.ru', token: 't', fetchImpl: impl as unknown as typeof fetch, sleep: async () => {} });
    return { client, impl };
  };

  it('чтение повторяет', async () => {
    const { client, impl } = flaky(2);
    expect(await client.listCards({ boardId: 1 })).toEqual([]);
    expect(impl).toHaveBeenCalledTimes(3);
  });

  it('запись не повторяет: запрос мог дойти, повтор дал бы дубль', async () => {
    const { client, impl } = flaky(1);
    await expect(client.createChecklist(1, 'Критерии', 1)).rejects.toThrow(/сеть.*ECONNRESET/);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
