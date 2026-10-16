/**
 * Вход Cloudflare Workers: OAuth, страницы, MCP.
 *
 * Только этот файл знает об облаке (OAuthProvider, KV, `env`). Ядро —
 * `mcp.ts`, `pages.ts`, `key.ts`, `gate.ts` — на стандартных Request/Response.
 *
 * Настройки — секреты Worker'а (`wrangler secret put`), в репозиторий не
 * попадают: SERVER_SECRET (32+ символов), KAITEN_DOMAIN (домен компании),
 * PUBLIC_URL (адрес сервера без завершающего «/»).
 */

import { AuthorizationError, CimdFetchError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { KaitenApiError, KaitenClient } from '../kaiten-client.js';
import { looksLikeAgentKey, openKey, sealToken } from './key.js';
import { handleMcp } from './mcp.js';
import { authorizePage, consentViewFromForm, homePage, htmlHeaders, keyPage, messagePage } from './pages.js';

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SERVER_SECRET: string;
  KAITEN_DOMAIN: string;
  PUBLIC_URL: string;
}

interface AgentProps {
  key: string;
}

const SCOPE = 'kaiten';

const html = (body: string, status = 200, headers?: Headers): Response => new Response(body, { status, headers: htmlHeaders(headers) });

const resourceOf = (env: Env): string => `${env.PUBLIC_URL.replace(/\/+$/, '')}/mcp`;

/** Проверить токен Kaiten у самого Kaiten; `null` — токен не принят. */
async function kaitenUser(env: Env, token: string): Promise<{ id: number; name: string } | null> {
  const client = new KaitenClient({ domain: env.KAITEN_DOMAIN, token, maxRetries: 1 });
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

async function issueKey(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const { token } = await readToken(request);
  if (!token) return html(homePage(origin, 'Вставьте токен Kaiten.'), 400);
  const user = await kaitenUser(env, token);
  if (!user) return html(homePage(origin, 'Kaiten не принял этот токен. Проверьте, что он скопирован целиком и не отозван.'), 400);
  return html(keyPage(origin, await sealToken(token, env.SERVER_SECRET), user.name));
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
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
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return html(messagePage('Подключение не удалось', error.description ?? 'Начните подключение заново.'), 400);
    if (error instanceof CimdFetchError) return html(messagePage('Подключение не удалось', 'Не удалось проверить приложение.'), 400);
    throw error;
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return authorize(request, env);
    if (url.pathname === '/key' && request.method === 'POST') return issueKey(request, env);
    if (url.pathname === '/' && request.method === 'GET') return html(homePage(url.origin));
    return html(messagePage('Не найдено', 'Такой страницы нет.'), 404);
  },
};

const apiHandler: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>['fetch']> } = {
  async fetch(request, env, ctx) {
    const props = (ctx as ExecutionContext & { props?: Partial<AgentProps> }).props;
    const token = props?.key ? await openKey(props.key, env.SERVER_SECRET) : null;
    if (!token) return new Response('Ключ не подходит к этому серверу', { status: 401 });
    return handleMcp(request, { domain: env.KAITEN_DOMAIN, token, secret: env.SERVER_SECRET });
  },
};

let provider: OAuthProvider<Env> | null = null;

/** Провайдер строится при первом запросе: адрес ресурса берётся из настроек. */
function providerFor(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    // Клиенты регистрируются сами: по документу метаданных (CIMD) или динамически (DCR).
    clientIdMetadataDocumentEnabled: true,
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
