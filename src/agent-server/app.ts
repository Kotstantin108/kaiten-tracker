/**
 * Агентский сервер целиком: OAuth, страницы, MCP — без привязки к месту
 * запуска. Входы — `worker.ts` (Cloudflare Workers) и `node.ts` (свой
 * сервер, Docker); они дают хранилища и настройки, остальное здесь.
 *
 * Настройки (в репозиторий не попадают): SERVER_SECRET (32+ символов),
 * KAITEN_DOMAIN (домен компании), PUBLIC_URL (адрес сервера без «/» в конце).
 * Хранилища: OAUTH_KV — OAuth (интерфейс KV Cloudflare), AGENT_STORE —
 * подтверждения и копии страниц.
 */

import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { KaitenApiError, KaitenClient } from '../kaiten-client.js';
import { confirmRoute, type HumanDeps, uploadRoute } from './human-pages.js';
import { looksLikeAgentKey, openKey, sealToken } from './key.js';
import { handleMcp } from './mcp.js';
import { authorizePage, consentViewFromForm, homePage, htmlHeaders, keyPage, loginPage, messagePage } from './pages.js';
import { makeSession, sessionCookie } from './session.js';
import type { Store } from './store.js';

export interface AgentEnv {
  /** Хранилище OAuth: KV Cloudflare или его замена на своём сервере (`node-kv.ts`). */
  OAUTH_KV: unknown;
  AGENT_STORE: Store;
  /** Ставит сам провайдер OAuth. */
  OAUTH_PROVIDER?: OAuthHelpers;
  SERVER_SECRET: string;
  KAITEN_DOMAIN: string;
  PUBLIC_URL: string;
}

/** Контекст запроса: провайдер кладёт в него `props` — ключ человека. Свой на каждый запрос. */
export interface AgentCtx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props?: unknown;
}

export interface AgentServerOptions {
  /**
   * Клиенты по документу метаданных (CIMD): сервер сам ходит по адресу,
   * который назвал клиент. Только в Cloudflare — там `fetch` не пускает во
   * внутреннюю сеть; на своём сервере — регистрация клиента (DCR).
   */
  cimd: boolean;
  /** Подменяется в тестах. */
  fetchImpl?: typeof fetch;
}

interface AgentProps {
  key: string;
}

const SCOPE = 'kaiten';

/** Человек ввёл токен сам — значит, может подтверждать действия агента в этом браузере. */
async function withSession(headers: Headers, userId: number, env: AgentEnv): Promise<Headers> {
  headers.append('Set-Cookie', sessionCookie(await makeSession(userId, env.SERVER_SECRET)));
  return headers;
}

const html = (body: string, status = 200, headers?: Headers): Response => new Response(body, { status, headers: htmlHeaders(headers) });

const resourceOf = (env: AgentEnv): string => `${env.PUBLIC_URL.replace(/\/+$/, '')}/mcp`;

function oauthOf(env: AgentEnv): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error('OAuth не подключён');
  return env.OAUTH_PROVIDER;
}

/** Агентский сервер: `fetch` — как у Worker'а, `env` и `ctx` дают входы. */
export function createAgentServer(options: AgentServerOptions): { fetch(request: Request, env: AgentEnv, ctx: AgentCtx): Promise<Response> } {
  const { fetchImpl } = options;

  /** Проверить токен Kaiten у самого Kaiten; `null` — токен не принят. */
  async function kaitenUser(env: AgentEnv, token: string): Promise<{ id: number; name: string } | null> {
    const client = new KaitenClient({ domain: env.KAITEN_DOMAIN, token, maxRetries: 1, ...(fetchImpl ? { fetchImpl } : {}) });
    try {
      const user = await client.currentUser();
      return { id: user.id, name: user.full_name ?? user.email ?? `#${user.id}` };
    } catch (error) {
      if (error instanceof KaitenApiError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  }

  async function readToken(request: Request): Promise<{ form: FormData; token: string }> {
    const form = await request.formData();
    const raw = form.get('token');
    return { form, token: typeof raw === 'string' ? raw.trim() : '' };
  }

  async function issueKey(request: Request, env: AgentEnv): Promise<Response> {
    const origin = new URL(request.url).origin;
    const { token } = await readToken(request);
    if (!token) return html(homePage(origin, 'Вставьте токен Kaiten.'), 400);
    const user = await kaitenUser(env, token);
    if (!user) return html(homePage(origin, 'Kaiten не принял этот токен. Проверьте, что он скопирован целиком и не отозван.'), 400);
    return html(keyPage(origin, await sealToken(token, env.SERVER_SECRET), user.name), 200, await withSession(new Headers(), user.id, env));
  }

  async function authorize(request: Request, env: AgentEnv): Promise<Response> {
    const oauth = oauthOf(env);
    try {
      if (request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return html(authorizePage(details, consent.handle), 200, consent.headers);
      }
      if (request.method !== 'POST') return html(messagePage('Ошибка', 'Метод не поддерживается.'), 405);

      const { form, token } = await readToken(request);
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      // Токен проверяем до approveConsent: тот расходует handle, а при ошибке
      // человек должен просто поправить токен на той же странице.
      const user = token ? await kaitenUser(env, token) : null;
      if (!user) {
        const error = token ? 'Kaiten не принял этот токен.' : 'Вставьте токен Kaiten.';
        return html(authorizePage(consentViewFromForm(form), handle, error), 400);
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const props: AgentProps = { key: await sealToken(token, env.SERVER_SECRET) };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: `kaiten-${user.id}`,
        metadata: { name: user.name },
        scope: approved.request.scope,
        props,
      });
      approved.headers.set('Location', redirectTo);
      await withSession(approved.headers, user.id, env);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return html(messagePage('Подключение не удалось', error.description ?? 'Начните подключение заново.'), 400);
      if (error instanceof CimdFetchError) return html(messagePage('Подключение не удалось', 'Не удалось проверить приложение.'), 400);
      throw error;
    }
  }

  async function login(request: Request, env: AgentEnv): Promise<Response> {
    const { form, token } = await readToken(request);
    const raw = String(form.get('next') ?? '');
    // Возврат — только на свою страницу подтверждения: никаких внешних адресов.
    const next = /^\/(confirm|upload)\/[A-Za-z0-9_-]+$/.test(raw) ? raw : '/';
    const user = token ? await kaitenUser(env, token) : null;
    if (!user) return html(loginPage(next, token ? 'Kaiten не принял этот токен.' : 'Вставьте токен Kaiten.'), 400);
    const headers = await withSession(new Headers({ Location: next }), user.id, env);
    return new Response(null, { status: 303, headers });
  }

  const humanDeps = (env: AgentEnv): HumanDeps => ({ store: env.AGENT_STORE, secret: env.SERVER_SECRET, domain: env.KAITEN_DOMAIN, ...(fetchImpl ? { fetchImpl } : {}) });

  const defaultHandler = {
    async fetch(request: Request, env: AgentEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return authorize(request, env);
      if (url.pathname === '/key' && request.method === 'POST') return issueKey(request, env);
      if (url.pathname === '/login' && request.method === 'POST') return login(request, env);
      const human = /^\/(confirm|upload)\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname);
      if (human && (request.method === 'GET' || request.method === 'POST')) {
        return human[1] === 'confirm' ? confirmRoute(request, humanDeps(env), human[2]) : uploadRoute(request, humanDeps(env), human[2]);
      }
      if (url.pathname === '/' && request.method === 'GET') return html(homePage(url.origin));
      return html(messagePage('Не найдено', 'Такой страницы нет.'), 404);
    },
  };

  const apiHandler = {
    async fetch(request: Request, env: AgentEnv, ctx: AgentCtx): Promise<Response> {
      const props = ctx.props as Partial<AgentProps> | undefined;
      const token = props?.key ? await openKey(props.key, env.SERVER_SECRET) : null;
      if (!token) return new Response('Ключ не подходит к этому серверу', { status: 401 });
      return handleMcp(request, {
        domain: env.KAITEN_DOMAIN,
        token,
        secret: env.SERVER_SECRET,
        store: env.AGENT_STORE,
        publicUrl: env.PUBLIC_URL,
        agentKey: props?.key ?? '',
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    },
  };

  let provider: OAuthProvider<AgentEnv> | null = null;

  /** Провайдер строится при первом запросе: адрес ресурса берётся из настроек. */
  function providerFor(env: AgentEnv): OAuthProvider<AgentEnv> {
    provider ??= new OAuthProvider<AgentEnv>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      // Клиенты регистрируются сами: по документу метаданных (CIMD) или динамически (DCR).
      clientIdMetadataDocumentEnabled: options.cimd,
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: resourceOf(env), resource_name: 'Агент для Kaiten' },
      // Пока человек пользуется агентом, вход живёт; месяц без дела — войти заново.
      refreshTokenTTL: 365 * 86400,
      refreshTokenIdleTTL: 30 * 86400,
      // Путь без браузера: ключ агента в заголовке. Это наш собственный ключ
      // (зашифрованный токен), а не чужой токен, — привязываем к своему ресурсу.
      resolveExternalToken: async ({ token, env: e }) => {
        if (!looksLikeAgentKey(token) || !(await openKey(token, e.SERVER_SECRET))) return null;
        const props: AgentProps = { key: token };
        return { props, audience: resourceOf(e) };
      },
    });
    return provider;
  }

  return {
    // Провайдер читает из контекста только props и waitUntil — полный ExecutionContext Workers ему не нужен.
    fetch: (request, env, ctx) => providerFor(env).fetch(request, env, ctx as Parameters<OAuthProvider<AgentEnv>['fetch']>[2]),
  };
}
