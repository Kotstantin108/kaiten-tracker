// Сборка агентского сервера для своего хоста (Docker): один файл ESM для Node 24.
// Библиотека OAuth импортирует `cloudflare:workers` только ради проверки
// `instanceof WorkerEntrypoint` — вне Workers это пустой класс
// (src/agent-server/cloudflare-workers-shim.ts).
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const outfile = process.argv[2] ?? 'dist/agent-server.mjs';

await build({
  entryPoints: ['src/agent-server/node.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  // Зависимости CommonJS внутри ESM-сборки зовут require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  plugins: [
    {
      name: 'cloudflare-workers-shim',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: fileURLToPath(new URL('../src/agent-server/cloudflare-workers-shim.ts', import.meta.url)) }));
      },
    },
  ],
});
console.log(`Собрано: ${outfile}`);
