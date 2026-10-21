/**
 * Вход своего сервера (Docker, любой хост с Node 24). Сервер — тот же, что в
 * Cloudflare (`app.ts`); хранилища — SQLite в DATA_DIR.
 *
 * Переменные окружения: SERVER_SECRET (32+ символов), KAITEN_DOMAIN,
 * PUBLIC_URL (внешний адрес по https), PORT (8787), DATA_DIR (/data).
 * HTTPS снаружи даёт обратный прокси (Caddy, nginx); сам сервер — http.
 */

import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createNodeHandler, readNodeConfig } from './node-http.js';
import { kvAsStore, SqliteKv } from './node-kv.js';

const config = readNodeConfig(process.env);
if ('problems' in config) {
  console.error(`Сервер не запущен — поправьте переменные окружения:\n${config.problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(2);
}

mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(join(config.dataDir, 'agent.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
const oauthKv = new SqliteKv(db, 'oauth');
const agentKv = new SqliteKv(db, 'agent');

const purge = (): void => {
  oauthKv.purgeExpired();
  agentKv.purgeExpired();
};
purge();
const timer = setInterval(purge, 60 * 60_000);
timer.unref();

const server = createServer(createNodeHandler(config, { oauthKv, store: kvAsStore(agentKv) }));
server.listen(config.port, () => console.log(`Агент для Kaiten: порт ${config.port}, адрес ${config.publicUrl}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
