import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Повторы сетевых вызовов git — без пауз: тесты обрывы связи не ждут.
    // Папки kaiten нет: тесты не обновляют kaiten и не пишут версию синхронизации, на какой бы ветке ни шли.
    env: { KAITEN_NET_RETRY: '0', KAITEN_TOOL_DIR: '' },
  },
});
