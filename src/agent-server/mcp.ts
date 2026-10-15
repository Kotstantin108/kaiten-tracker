/**
 * MCP-сервер агента: инструменты над Kaiten от имени человека.
 *
 * Без состояния: на каждый HTTP-запрос — свой сервер и транспорт. Только
 * стандартные Request/Response, поэтому ядро не знает, где оно запущено
 * (Cloudflare сейчас, свой сервер потом).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

import { KaitenApiError, KaitenClient } from '../kaiten-client.js';
import { gatedFetch } from './gate.js';

export interface AgentContext {
  /** Домен компании в Kaiten, например `acme.kaiten.ru`. */
  domain: string;
  /** Токен Kaiten человека — уже расшифрованный из ключа. */
  token: string;
  /** Подменяется в тестах. */
  fetchImpl?: typeof fetch;
}

export const SERVER_INSTRUCTIONS = [
  'Сервер работает с Kaiten от имени пользователя.',
  'Прежде чем заводить или менять карточку, прочитай правила доски.',
  'Всё, чего не хватает, спроси у пользователя одним сообщением — не придумывай значения.',
  'Перед созданием покажи пользователю предпросмотр.',
  'Удалять и архивировать сервер не умеет — это делает человек в Kaiten.',
].join(' ');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

/** Текст отказа заслонки из тела ответа; `null` — это ответ самого Kaiten. */
function gateMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = parsed !== null && typeof parsed === 'object' ? (parsed as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message.startsWith('Действие заблокировано') ? message : null;
  } catch {
    return null;
  }
}

/** Ошибка инструмента — по-русски и без внутренностей: что случилось и что делать. */
export function describeError(error: unknown): string {
  if (error instanceof KaitenApiError) {
    const gate = gateMessage(error.body);
    if (gate) return gate;
    if (error.status === 401) return 'Kaiten не принял ключ: токен перевыпущен или отозван. Получите новый ключ на странице сервера.';
    if (error.status === 403) return 'В Kaiten у вас нет прав на это действие.';
    if (error.status === 404) return 'Не найдено в Kaiten (или нет доступа).';
    return `Kaiten ответил ошибкой ${error.status}. Попробуйте позже.`;
  }
  return 'Внутренняя ошибка сервера.';
}

export function kaitenFor(ctx: AgentContext): KaitenClient {
  const domain = ctx.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return new KaitenClient({
    domain,
    token: ctx.token,
    fetchImpl: gatedFetch(ctx.fetchImpl ?? fetch, `https://${domain}/api/latest`),
    maxRetries: 2,
  });
}

export function buildServer(ctx: AgentContext): McpServer {
  const server = new McpServer(
    { name: 'kaiten-agent', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  const kaiten = kaitenFor(ctx);

  server.registerTool(
    'whoami',
    {
      title: 'Кто я в Kaiten',
      description: 'Показывает, от чьего имени агент работает в Kaiten. Вызови первым, чтобы проверить подключение.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const user = await kaiten.currentUser();
        return text(`Подключено к Kaiten как ${user.full_name ?? 'без имени'} (${user.email ?? 'почта не указана'}).`);
      } catch (error) {
        return text(describeError(error), true);
      }
    },
  );

  return server;
}

/** Обработать один HTTP-запрос MCP. */
export async function handleMcp(request: Request, ctx: AgentContext): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
