/**
 * KV на SQLite — замена Cloudflare KV на своём сервере (`node.ts`).
 *
 * Повторяет ровно то, что вызывают провайдер OAuth и ядро: `get` (текст или
 * JSON), `put` со сроком (`expirationTtl` — секунд от сейчас, `expiration` —
 * момент в секундах) и метаданными, `delete`, `list` по префиксу с курсором и
 * `list_complete`. Истёкшее не видно ни `get`, ни `list`, а удаляется
 * `purgeExpired`.
 *
 * Одна база — на один экземпляр сервера: SQLite не делится между машинами.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Store } from './store.js';

export interface KvPutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

export interface KvListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KvListResult {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
}

const MAX_LIST = 1000;

interface Row {
  key: string;
  value: string;
  metadata: string | null;
  expires: number | null;
}

export class SqliteKv {
  constructor(
    private readonly db: DatabaseSync,
    private readonly table: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`Недопустимое имя таблицы: ${table}`);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT, expires INTEGER)`);
  }

  async get(key: string, options?: { type?: 'text' | 'json' } | 'text' | 'json'): Promise<unknown> {
    const row = this.db.prepare(`SELECT value FROM ${this.table} WHERE key = ? AND (expires IS NULL OR expires > ?)`).get(key, this.now()) as Pick<Row, 'value'> | undefined;
    if (!row) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options: KvPutOptions = {}): Promise<void> {
    const expires = options.expiration !== undefined ? options.expiration * 1000 : options.expirationTtl !== undefined ? this.now() + options.expirationTtl * 1000 : null;
    const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
    this.db
      .prepare(`INSERT INTO ${this.table} (key, value, metadata, expires) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires = excluded.expires`)
      .run(key, String(value), metadata, expires);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key);
  }

  /** Ключи по алфавиту; курсор — последний отданный ключ. */
  async list(options: KvListOptions = {}): Promise<KvListResult> {
    const prefix = options.prefix ?? '';
    const limit = Math.max(1, Math.min(options.limit ?? MAX_LIST, MAX_LIST));
    const rows = this.db
      .prepare(`SELECT key, metadata, expires FROM ${this.table} WHERE substr(key, 1, ?) = ? AND key > ? AND (expires IS NULL OR expires > ?) ORDER BY key LIMIT ?`)
      .all(prefix.length, prefix, options.cursor ?? '', this.now(), limit + 1) as Array<Omit<Row, 'value'>>;
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires !== null ? { expiration: Math.floor(r.expires / 1000) } : {}),
        ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as unknown } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: page[page.length - 1].key }),
    };
  }

  /** Убрать истёкшие записи; сколько удалено. */
  purgeExpired(): number {
    return Number(this.db.prepare(`DELETE FROM ${this.table} WHERE expires IS NOT NULL AND expires <= ?`).run(this.now()).changes);
  }
}

/** Хранилище ядра (подтверждения, копии страниц) поверх KV. */
export function kvAsStore(kv: SqliteKv): Store {
  return {
    get: async (key) => (await kv.get(key)) as string | null,
    put: (key, value, ttl) => kv.put(key, value, { expirationTtl: ttl }),
    delete: (key) => kv.delete(key),
    list: async (prefix) => (await kv.list({ prefix })).keys.map((k) => k.name),
  };
}
