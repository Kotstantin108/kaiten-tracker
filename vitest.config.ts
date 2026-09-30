import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Повторы сетевых вызовов git — без пауз: тесты обрывы связи не ждут.
    env: { KAITEN_NET_RETRY: '0' },
  },
});
