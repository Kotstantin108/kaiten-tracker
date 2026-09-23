/**
 * Снимок структуры аккаунта Kaiten: пространства, доски, колонки, типы карточек
 * и кастомные свойства — сырым JSON в `tmp/kaiten-import/`.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ КОМАНДА. Пути эндпоинтов известны из документации, а состав
 * полей описан не полностью, и id в каждом аккаунте свои. Сначала смотрим, что
 * реально отдаёт аккаунт, и по снимку заполняем блок `kaiten` в
 * `tracker.config.json`: id доски, id колонок под статусы, id типов карточек,
 * id свойства приоритета.
 *
 * Запуск: `npm run inspect -- --space <id> --board <id>`
 * ENV: `KAITEN_DOMAIN`, `KAITEN_TOKEN`. Ничего не изменяет, только читает.
 *
 * Коды выхода: 0 — ок; 2 — нет токена; 6 — ошибка запроса.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KaitenClient } from './kaiten-client.js';

const OUT_DIR = 'tmp/kaiten-import';

function argValue(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index !== -1 && argv[index + 1]) return Number(argv[index + 1]);
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline ? Number(inline.slice(name.length + 1)) : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const domain = process.env.KAITEN_DOMAIN ?? '';
  const token = process.env.KAITEN_TOKEN ?? '';
  if (!domain || !token) {
    console.error('Нужны KAITEN_DOMAIN и KAITEN_TOKEN в окружении (`--env-file=.env`).');
    process.exit(2);
  }

  const client = new KaitenClient({ domain, token });
  const structure = await client.inspectStructure(argValue(argv, '--space'), argValue(argv, '--board'));

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `structure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(structure, null, 2), 'utf8');

  console.log(`Снимок структуры: ${path} (запросов: ${client.requestCount})`);
  console.log('Дальше: перенести id доски, колонок, типов и свойства приоритета в блок kaiten файла tracker.config.json');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(6);
});
