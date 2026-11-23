/**
 * Ночной бэкап Kaiten — снимок аккаунта в JSON-файлы (решение 28.09: своего
 * сервера нет, по расписанию только бэкап в GitHub Actions, в отдельный
 * приватный репозиторий владельца). Только чтение.
 *
 * РАСКЛАДКА — файл на сущность, чтобы ночной коммит был диффом, а не новым
 * архивом:
 *   company/card-types.json, company/custom-properties.json (с вариантами
 *   выбора), spaces/<id>/space.json, boards.json (колонки, дорожки),
 *   restrictions.json, spaces/<id>/cards/<id>.json (карточка целиком из
 *   `GET /cards/{id}`: описание, чек-листы, участники — и её комментарии).
 * Карточки — со всех досок пространства, архивные тоже. Карточки, которых
 * больше нет, из снимка удаляются: прошлые версии — в истории репозитория.
 *
 * Ответы пишутся как есть (схемы `passthrough`): бэкап не должен терять поля,
 * которых мы не читаем. Токен — только из окружения, в вывод не попадает;
 * вывод — только числа.
 *
 *   pnpm run backup --out <папка> [--spaces <id>,<id>]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { KaitenClient } from './kaiten-client.js';
import { endWith } from './exit.js';

/** Путь в снимке → содержимое. */
export type Snapshot = Map<string, unknown>;

export interface SnapshotStats {
  spaces: number;
  boards: number;
  cards: number;
  comments: number;
}

const byId = <T extends { id: number }>(items: T[]): T[] => [...items].sort((a, b) => a.id - b.id);

export async function takeSnapshot(client: KaitenClient, only?: ReadonlySet<number>): Promise<{ files: Snapshot; stats: SnapshotStats }> {
  const files: Snapshot = new Map();
  const stats: SnapshotStats = { spaces: 0, boards: 0, cards: 0, comments: 0 };

  files.set('company/card-types.json', byId(await client.listCardTypes()));
  const properties = byId(await client.listCustomProperties());
  const withValues = [];
  for (const property of properties) {
    withValues.push(property.type === 'select' ? { ...property, select_values: byId(await client.listSelectValues(property.id)) } : property);
  }
  files.set('company/custom-properties.json', withValues);

  for (const space of byId(await client.listSpaces())) {
    if (only && !only.has(space.id)) continue;
    stats.spaces += 1;
    const base = `spaces/${space.id}`;
    files.set(`${base}/space.json`, space);
    const boards = byId(await client.listBoards(space.id));
    files.set(`${base}/boards.json`, boards);
    files.set(`${base}/restrictions.json`, await client.listRestrictions(space.id));
    for (const board of boards) {
      stats.boards += 1;
      for (const listed of byId(await client.listCards({ boardId: board.id }))) {
        const card = await client.getCard(listed.id);
        const comments = await client.listComments(listed.id);
        files.set(`${base}/cards/${listed.id}.json`, { card, comments });
        stats.cards += 1;
        stats.comments += comments.length;
      }
    }
  }
  return { files, stats };
}

/**
 * JSON с ключами по алфавиту: Kaiten отдаёт ключи одного и того же объекта в
 * разном порядке (живьём 29.09 повторный снимок без изменений в аккаунте
 * переписывал 47 файлов из 67), а бэкап должен меняться только вместе с данными.
 */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'));
}

/**
 * Записать снимок: изменившиеся файлы — заново, пропавшие сущности —
 * удалить (только внутри `company/` и `spaces/`: чужие файлы репозитория
 * бэкапа не трогаем). Возвращает, сколько файлов изменено и удалено.
 */
export function writeSnapshot(dir: string, files: Snapshot): { written: number; removed: number } {
  let written = 0;
  let removed = 0;
  for (const [path, value] of files) {
    const target = join(dir, path);
    const text = stableJson(value);
    if (existsSync(target) && readFileSync(target, 'utf8') === text) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written += 1;
  }
  for (const root of ['company', 'spaces']) {
    for (const path of jsonFiles(join(dir, root))) {
      const key = `${root}/${path}`;
      if (files.has(key)) continue;
      rmSync(join(dir, key));
      removed += 1;
    }
  }
  return { written, removed };
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const out = argValue(argv, '--out');
  if (!out) {
    console.error('Укажите папку снимка: pnpm run backup --out <папка> [--spaces <id>,<id>]');
    process.exit(2);
  }
  const domain = process.env.KAITEN_DOMAIN;
  const token = process.env.KAITEN_TOKEN;
  if (!domain || !token) {
    console.error('Нет входа в Kaiten: KAITEN_DOMAIN и KAITEN_TOKEN в окружении');
    process.exit(2);
  }
  const spaces = argValue(argv, '--spaces');
  const only = spaces ? new Set(spaces.split(',').map((s) => Number(s.trim()))) : undefined;
  const client = new KaitenClient({ domain, token, minIntervalMs: 150 });
  const { files, stats } = await takeSnapshot(client, only);
  const { written, removed } = writeSnapshot(out, files);
  console.log(`Пространств ${stats.spaces}, досок ${stats.boards}, карточек ${stats.cards}, комментариев ${stats.comments}; файлов изменено ${written}, удалено ${removed}; запросов ${client.requestCount}.`);
}

// Запуск как скрипта, не при импорте из тестов.
if (process.argv[1] && /kaiten-backup\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    endWith(1);
  });
}
