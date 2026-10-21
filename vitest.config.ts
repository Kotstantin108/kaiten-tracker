import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Повторы сетевых вызовов git — без пауз: тесты обрывы связи не ждут.
    // Папки kaiten нет: тесты не обновляют kaiten и не пишут версию синхронизации, на какой бы ветке ни шли.
    env: { KAITEN_NET_RETRY: '0', KAITEN_TOOL_DIR: '' },
    // Библиотека OAuth импортирует `cloudflare:workers` — в тестах, как и на своём сервере, это заглушка.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./src/agent-server/cloudflare-workers-shim.ts', import.meta.url)) } },
});
