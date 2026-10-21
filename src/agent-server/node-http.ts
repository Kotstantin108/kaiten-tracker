/**
 * Свой сервер (Docker): HTTP Node ↔ стандартные Request/Response сервера
 * из `app.ts`, настройки из переменных окружения.
 *
 * Адрес запроса берётся из PUBLIC_URL, а не из Host: за обратным прокси
 * Node видит http и внутренний адрес, а OAuth сверяет издателя и ресурс с
 * адресом запроса. Ответы идут потоком (MCP отвечает и SSE), каждый
 * Set-Cookie — отдельным заголовком.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { type AgentCtx, type AgentEnv, createAgentServer } from './app.js';
import type { Store } from './store.js';

export interface NodeConfig {
  secret: string;
  domain: string;
  publicUrl: string;
  port: number;
  dataDir: string;
}

/** Настройки из окружения; не хватает — список того, что поправить (значений не показываем). */
export function readNodeConfig(env: Record<string, string | undefined>): NodeConfig | { problems: string[] } {
  const problems: string[] = [];
  const secret = env.SERVER_SECRET ?? '';
  const domain = (env.KAITEN_DOMAIN ?? '').trim();
  const publicUrl = (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (secret.length < 32) problems.push('SERVER_SECRET — не короче 32 символов');
  if (!domain) problems.push('KAITEN_DOMAIN — домен компании в Kaiten, например acme.kaiten.ru');
  let url: URL | null = null;
  try {
    url = publicUrl ? new URL(publicUrl) : null;
  } catch {
    url = null;
  }
  const loopback = url !== null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || url.pathname !== '/' || url.search || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    problems.push('PUBLIC_URL — внешний адрес сервера по https без пути, например https://agent.example.com');
  }
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT — число от 1 до 65535');
  if (problems.length > 0) return { problems };
  return { secret, domain, publicUrl, port, dataDir: env.DATA_DIR ?? '/data' };
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

/** Тело запроса больше — 413: файл до 10 МБ плюс обёртка формы. Без входа тело читают формы и OAuth. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

export class BodyTooLarge extends Error {}

/** Поток тела, который обрывается, когда байтов больше предела (и без Content-Length). */
function limited(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new BodyTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** Запрос Node → Request по внешнему адресу сервера. */
export function toRequest(req: IncomingMessage, publicUrl: string, signal: AbortSignal, maxBody = MAX_BODY_BYTES): Request {
  // Только путь: адрес в абсолютной форме (`GET http://…`) не подменит хост.
  const path = req.url?.startsWith('/') ? req.url : '/';
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, req.rawHeaders[i + 1]);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : limited(Readable.toWeb(req) as ReadableStream<Uint8Array>, maxBody);
  return new Request(`${publicUrl}${path}`, { method, headers, signal, ...(body ? { body, duplex: 'half' } : {}) });
}

/** Response → ответ Node потоком; клиент ушёл — поток ответа отменяется. */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  // Заголовки — сразу: иначе Node придержит их до первого куска тела, а клиент SSE ждёт ответа.
  res.flushHeaders();
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('close', () => void reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
  } catch {
    // Клиент ушёл или поток оборвался — дописывать некому.
  }
  res.end();
}

export interface NodeDeps {
  /** Хранилище OAuth (интерфейс KV). */
  oauthKv: unknown;
  store: Store;
  /** Подменяется в тестах. */
  fetchImpl?: typeof fetch;
}

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** Обработчик для `http.createServer`: свой контекст на каждый запрос; сам не падает никогда. */
export function createNodeHandler(
  config: Pick<NodeConfig, 'secret' | 'domain' | 'publicUrl'>,
  deps: NodeDeps,
  maxBody = MAX_BODY_BYTES,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // Свой fetch Node ходит куда угодно, в том числе во внутреннюю сеть, — по
  // адресу от клиента (CIMD) не ходим; клиенты регистрируются сами (DCR).
  const server = createAgentServer({ cimd: false, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const env: AgentEnv = { OAUTH_KV: deps.oauthKv, AGENT_STORE: deps.store, SERVER_SECRET: config.secret, KAITEN_DOMAIN: config.domain, PUBLIC_URL: config.publicUrl };
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  return async (req, res) => {
    // Необработанный отказ уронил бы процесс и все открытые потоки — ловим всё.
    try {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // Контекст — новый на каждый запрос: провайдер кладёт в него ключ человека.
      const ctx: AgentCtx = {
        waitUntil: (promise) => void promise.catch((error: unknown) => console.error('Фоновая задача не удалась:', message(error))),
        passThroughOnException: () => undefined,
      };
      let response: Response;
      if (Number(req.headers['content-length'] ?? 0) > maxBody) {
        response = plain(413, 'Слишком большой запрос');
      } else {
        try {
          response = await server.fetch(toRequest(req, config.publicUrl, abort.signal, maxBody), env, ctx);
        } catch (error) {
          // Тело оборвалось на пределе — где бы его ни читали, это 413, а не сбой.
          const tooLarge = error instanceof BodyTooLarge || (error instanceof Error && error.cause instanceof BodyTooLarge);
          if (!tooLarge) console.error('Ошибка запроса:', message(error));
          response = tooLarge ? plain(413, 'Слишком большой запрос') : plain(500, 'Внутренняя ошибка сервера');
        }
      }
      await sendResponse(res, response);
    } catch (error) {
      console.error('Ответ не отправлен:', message(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}
