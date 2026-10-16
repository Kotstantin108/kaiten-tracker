/**
 * Хранилище сервера: ожидающие подтверждения и копии страниц перед правкой.
 *
 * Ядро знает только этот интерфейс: в Cloudflare за ним KV, в тестах —
 * память, на своём сервере — что угодно с TTL. Значения кладутся уже
 * зашифрованными (`sealData`): хранилище общее для всех людей, и доступ к
 * записи даёт не ключ, а проверка доступа к странице в Kaiten.
 */

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Ключи с префиксом (до 1000). */
  list(prefix: string): Promise<string[]>;
}

export class MemoryStore implements Store {
  private readonly items = new Map<string, { value: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expires <= this.now()) {
      this.items.delete(key);
      return null;
    }
    return item.value;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for (const key of this.items.keys()) if (key.startsWith(prefix) && (await this.get(key)) !== null) keys.push(key);
    return keys.sort();
  }
}
