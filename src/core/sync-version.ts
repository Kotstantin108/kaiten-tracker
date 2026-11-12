/**
 * Версия синхронизации: что `kaiten` пишет в карточки Kaiten. Поднимается,
 * когда другая версия переписала бы карточки по-своему (журнал файлом или
 * ссылкой) — тогда разные версии на разных машинах спорили бы о карточках.
 *
 * Синхронизация записывает свою версию в репозиторий задач файлом
 * `kaiten-sync.json`. Версия там новее своей — эта копия `kaiten` устарела:
 * в карточки она не пишет, а сама обновляется (`self-update.ts`).
 */

import { z } from 'zod';

/**
 * 3 — «Было / Стало»: ключ `visual` в задачах, старая копия таких задач не читает.
 * 4 — `pending_moves`: статус, сменённый без Kaiten; старая копия таких задач не читает
 * и вернула бы статус из карточки.
 * 5 — картинки `было-стало/`, убранные из задачи (`kaiten detach`), сверка убирает
 * из карточки; старая копия отметила бы доставку, не убрав их, и новая к карточке
 * уже не вернулась бы.
 * 6 — статус `found` («Находки», `core/found.ts`) и «Можно младшему» только с
 * «Бэклога»: старая копия задач в новом статусе не читает, а карточкам во
 * «Входящих» вернула бы признак, который новая снимает.
 * 7 — гейты сдачи (`core/review-gates.ts`): ключи `checks` и `domain` в задачах и
 * поле «Домен» в карточке; старая копия таких задач не читает.
 */
export const SYNC_VERSION = 7;

/** Файл версии в корне репозитория задач; пишет только синхронизация. */
export const SYNC_VERSION_FILE = 'kaiten-sync.json';

const FileSchema = z.object({ version: z.number().int().positive() }).strict();

/** Версия из файла; файла нет или он не читается — 0: такой файл не повод останавливать синхронизацию. */
export function parseSyncVersion(text: string | undefined): number {
  if (text === undefined) return 0;
  try {
    const parsed = FileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.version : 0;
  } catch {
    return 0;
  }
}

export function renderSyncVersion(version: number): string {
  return `${JSON.stringify({ version }, null, 2)}\n`;
}
