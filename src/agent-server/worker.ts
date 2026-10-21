/**
 * Вход Cloudflare Workers. Сервер целиком — в `app.ts`; здесь только то, что
 * знает об облаке: KV и секреты Worker'а (`wrangler secret put`).
 *
 * Хранилища: OAUTH_KV — OAuth, AGENT_KV — подтверждения и копии страниц.
 */

import { type AgentEnv, createAgentServer } from './app.js';
import type { Store } from './store.js';

interface Env {
  OAUTH_KV: KVNamespace;
  AGENT_KV: KVNamespace;
  SERVER_SECRET: string;
  KAITEN_DOMAIN: string;
  PUBLIC_URL: string;
}

/** Хранилище ядра поверх KV (TTL в KV — не меньше 60 секунд). */
function kvStore(kv: KVNamespace): Store {
  return {
    get: (key) => kv.get(key),
    put: (key, value, ttl) => kv.put(key, value, { expirationTtl: Math.max(60, ttl) }),
    delete: (key) => kv.delete(key),
    list: async (prefix) => (await kv.list({ prefix })).keys.map((k) => k.name),
  };
}

// fetch Worker'а не пускает во внутреннюю сеть (global_fetch_strictly_public) — CIMD можно.
const server = createAgentServer({ cimd: true });
let agentEnv: AgentEnv | null = null;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    agentEnv ??= { OAUTH_KV: env.OAUTH_KV, AGENT_STORE: kvStore(env.AGENT_KV), SERVER_SECRET: env.SERVER_SECRET, KAITEN_DOMAIN: env.KAITEN_DOMAIN, PUBLIC_URL: env.PUBLIC_URL };
    return server.fetch(request, agentEnv, ctx);
  },
} satisfies ExportedHandler<Env>;
