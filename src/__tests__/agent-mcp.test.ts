/**
 * MCP-сервер агента целиком: HTTP-запрос MCP → инструмент → поддельный Kaiten.
 * Проверяется, что сервер живёт без состояния (каждый запрос сам по себе),
 * отвечает по-русски и не выдаёт внутренностей в ошибках.
 */
import { describe, expect, it, vi } from 'vitest';

import { handleMcp } from '../agent-server/mcp.js';

const DOMAIN = 'acme.example.com';

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): Request {
  return new Request('https://agent.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

function kaiten(routes: Record<string, { status?: number; body: unknown }>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const path = new URL(String(input)).pathname.replace('/api/latest', '');
    const route = routes[path];
    if (!route) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
}

async function call(request: Request, fetchImpl: typeof fetch): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const response = await handleMcp(request, { domain: DOMAIN, token: 't', fetchImpl });
  expect(response.status).toBe(200);
  return (await response.json()) as { result?: Record<string, unknown> };
}

describe('агентский MCP-сервер', () => {
  it('представляется и даёт инструкции', async () => {
    const reply = await call(
      rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
      kaiten({}),
    );
    expect(reply.result?.serverInfo).toMatchObject({ name: 'kaiten-agent' });
    expect(String(reply.result?.instructions)).toMatch(/правила доски/);
  });

  it('whoami — от чьего имени работает агент', async () => {
    const fetchImpl = kaiten({ '/users/current': { body: { id: 7, full_name: 'Alice', email: 'alice@example.com' } } });
    const reply = await call(rpc('tools/call', { name: 'whoami', arguments: {} }), fetchImpl);
    const content = reply.result?.content as Array<{ text: string }>;
    expect(content[0].text).toContain('Alice');
    expect(reply.result?.isError).toBeUndefined();
  });

  it('отозванный токен — понятная ошибка, а не стек', async () => {
    const fetchImpl = kaiten({ '/users/current': { status: 401, body: { message: 'Unauthorized' } } });
    const reply = await call(rpc('tools/call', { name: 'whoami', arguments: {} }), fetchImpl);
    const content = reply.result?.content as Array<{ text: string }>;
    expect(reply.result?.isError).toBe(true);
    expect(content[0].text).toMatch(/новый ключ/);
  });
});
