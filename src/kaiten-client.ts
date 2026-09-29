/**
 * Клиент Kaiten API под заливку задач.
 *
 * ЧТО ПРОВЕРЕНО ПО ДОКУМЕНТАЦИИ (developers.kaiten.ru, 23.09.2026) и на что
 * опирается код:
 *   · база `https://<домен>.kaiten.ru/api/latest`, авторизация `Bearer <token>`;
 *   · `POST /cards` — обязательны только `title` и `board_id`; `external_id`
 *     («Any external id you want to assign to card»); `text_format_type_id`
 *     1 = markdown (по умолчанию), 2 = html, 3 = jira wiki; кастомные поля —
 *     `properties: { id_<property_id>: value }`;
 *   · `GET /cards` — фильтры `board_id`, `external_id`, пагинация `limit`
 *     (по умолчанию 100, максимум 100) и `offset`;
 *   · `PATCH /cards/{id}`;
 *   · 50 rps, остаток в `X-RateLimit-Remaining`, момент сброса в `X-RateLimit-Reset`.
 *
 * ЧТО НЕ ПРОВЕРЕНО и поэтому сделано осторожно: точность фильтра `external_id`
 * («Search by external id filter» — точное совпадение или подстрока,
 * неизвестно), поэтому `findCardByExternalId` всегда перепроверяет совпадение
 * на клиенте и падает, если сервер вернул чужую карточку. Схемы ответов —
 * `passthrough()` и описывают только те поля, которые мы реально читаем:
 * структура карточки целиком не задокументирована, и жёсткая схема сломала бы
 * импорт на первом же незнакомом поле.
 *
 * Эндпоинты структуры аккаунта проверены по документации 23.09.2026:
 * `GET /spaces/{id}/boards` (отдаёт заодно `columns` и `lanes`),
 * `GET /boards/{id}/columns` (у колонки есть `type`: 1 очередь, 2 в работе,
 * 3 готово, и вложенные `subcolumns`), `GET /card-types` (пагинация, limit до
 * 100), `GET /company/custom-properties` (с `include_values=true` приходят
 * значения каталога; значения селектов — `/company/custom-properties/{id}/select-values`;
 * общий путь `/custom-property-select-values` живьём 23.09.2026 ответил 404).
 * Формат ответов при этом описан не целиком, поэтому `inspect` сохраняет сырой
 * JSON в `tmp/`, и маппинг настраивается по нему, а не по догадкам.
 *
 * Токен в логи не попадает ни в каком виде.
 */

import { z } from 'zod';

export const CardSchema = z
  .object({
    id: z.number(),
    title: z.string().optional(),
    external_id: z.union([z.string(), z.number(), z.null()]).optional(),
    board_id: z.number().optional(),
    column_id: z.number().optional(),
    lane_id: z.number().optional(),
    type_id: z.number().optional(),
    archived: z.boolean().optional(),
    /**
     * Срок карточки; `null` — нет (живьём 28.09: в списке есть). Срок без
     * времени приходит полночью UTC: `2026-10-15T00:00:00.000Z` при
     * `due_date_time_present: false` (живьём 29.09).
     */
    due_date: z.string().nullable().optional(),
    due_date_time_present: z.boolean().optional(),
    /** Когда карточку перенесли в текущую колонку (живьём 28.09: в списке есть). */
    column_changed_at: z.string().nullable().optional(),
    /** Родители карточки; `null` — родителей нет (снято с живого аккаунта 23.09.2026). */
    parents_ids: z.array(z.number()).nullable().optional(),
    children_ids: z.array(z.number()).nullable().optional(),
    /** Значения полей: `id_<поле>` → значение (селект — массив id вариантов). */
    properties: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Описание — только в `GET /cards/{id}`; у пустой карточки `null` (живьём 29.09). */
    description: z.string().nullable().optional(),
    /** Формат описания; живьём 29.09 в ответе карточки поля нет — markdown по умолчанию API. */
    text_format_type_id: z.number().optional(),
    /** Когда карточку завели, UTC ISO (живьём 29.09: и в списке, и в карточке). */
    created: z.string().optional(),
    /** Кто завёл карточку (живьём 29.09: и в списке, и в карточке). */
    owner: z.object({ email: z.string().nullable().optional(), full_name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    /** Чек-листы приходят в карточке целиком (`GET /cards/{id}`); читаем только имена. */
    checklists: z
      .array(
        z
          .object({
            id: z.number(),
            name: z.string().nullable().optional(),
            items: z
              .array(z.object({ id: z.number().optional(), text: z.string().nullable().optional(), checked: z.boolean().optional() }).passthrough())
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

export type Card = z.infer<typeof CardSchema>;

const CardListSchema = z.array(CardSchema);

const ColumnSchema = z
  .object({ id: z.number(), title: z.string().default(''), type: z.number().optional(), sort_order: z.number().optional() })
  .passthrough();
const LaneSchema = z.object({ id: z.number(), title: z.string().nullable().optional() }).passthrough();

export const SpaceSchema = z
  .object({ id: z.number(), uid: z.string().optional(), title: z.string().default(''), archived: z.boolean().optional() })
  .passthrough();
export type Space = z.infer<typeof SpaceSchema>;

export const BoardSchema = z
  .object({
    id: z.number(),
    title: z.string().default(''),
    columns: z.array(ColumnSchema).default([]),
    lanes: z.array(LaneSchema).default([]),
  })
  .passthrough();
export type Board = z.infer<typeof BoardSchema>;

/** Поле, предлагаемое к заполнению в типе карточки (`card_properties`, документация card-types). */
export const CardTypePropertySchema = z
  .object({
    regular_property: z.string().nullable().optional(),
    property_uid: z.string().nullable().optional(),
    sort_order: z.number().optional(),
    required: z.boolean().optional(),
  })
  .passthrough();
export type CardTypeProperty = z.infer<typeof CardTypePropertySchema>;

export const CardTypeSchema = z
  .object({
    id: z.number(),
    name: z.string().default(''),
    letter: z.string().optional(),
    archived: z.boolean().optional(),
    description_template: z.string().nullable().optional(),
    card_properties: z.array(CardTypePropertySchema).nullable().optional(),
  })
  .passthrough();
export type CardType = z.infer<typeof CardTypeSchema>;

export const CustomPropertySchema = z
  .object({ id: z.number(), uid: z.string().optional(), name: z.string().default(''), type: z.string().optional(), condition: z.string().optional() })
  .passthrough();
export type CustomProperty = z.infer<typeof CustomPropertySchema>;

export const SelectValueSchema = z
  .object({ id: z.number(), value: z.string().default(''), condition: z.string().optional() })
  .passthrough();
export type SelectValue = z.infer<typeof SelectValueSchema>;

export interface CardPayload {
  title: string;
  board_id: number;
  column_id?: number;
  lane_id?: number;
  type_id?: number;
  description?: string;
  external_id?: string;
  /** 1 — markdown, значение по умолчанию у API; ставим явно. */
  text_format_type_id?: 1 | 2 | 3;
  properties?: Record<string, unknown>;
  asap?: boolean;
  due_date?: string;
}

export interface KaitenClientOptions {
  domain: string;
  token: string;
  /** Подменяется в тестах; по умолчанию глобальный fetch. */
  fetchImpl?: typeof fetch;
  /** Подменяется в тестах, чтобы не спать по-настоящему. */
  sleep?: (ms: number) => Promise<void>;
  /** Сколько раз повторять 429 и 5xx. */
  maxRetries?: number;
  /** Порог остатка лимита, ниже которого клиент ждёт окна. */
  rateLimitFloor?: number;
  /**
   * Минимальная пауза между запросами. Живьём 23.09.2026 всплеск записей
   * (~40 запросов за секунды, ниже заявленных 50 rps) оборвался сетевой ошибкой
   * `fetch failed` — поэтому массовые команды идут с паузой. 0 — без паузы.
   */
  minIntervalMs?: number;
}

export class KaitenApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'KaitenApiError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class KaitenClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly rateLimitFloor: number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  /** Счётчик запросов — уходит в отчёт, чтобы видеть цену прогона. */
  requestCount = 0;

  constructor(options: KaitenClientOptions) {
    const domain = options.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.base = `https://${domain}/api/latest`;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 5;
    this.rateLimitFloor = options.rateLimitFloor ?? 2;
    this.minIntervalMs = options.minIntervalMs ?? 0;
  }

  /**
   * Сетевой обрыв (fetch бросил, ответа нет). Чтение повторяем — оно без
   * последствий. Запись — нет: запрос мог дойти до сервера, и повтор создал бы
   * дубль карточки или пункта; такие прогоны перезапускаются целиком, заливка
   * идемпотентна.
   */
  private async send(method: string, path: string, url: string, init: RequestInit, attempt: number): Promise<Response | null> {
    if (this.minIntervalMs > 0) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt = Date.now();
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      const detail = `${method} ${path}: сеть — ${(error as Error).message}${cause ? ` (${cause})` : ''}`;
      if (method !== 'GET' || attempt >= this.maxRetries) throw new KaitenApiError(detail, 0, '');
      return null;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; schema: z.ZodType<T> },
  ): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      const response = await this.send(method, path, url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-kaiten-Client': 'kaiten-tracker-import',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }, attempt);
      if (response === null) {
        await this.sleep(Math.min(2 ** attempt * 500, 30_000));
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new KaitenApiError(
            `${method} ${path}: ${response.status} после ${attempt + 1} попыток`,
            response.status,
            await safeText(response),
          );
        }
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        throw new KaitenApiError(`${method} ${path}: ${response.status}`, response.status, await safeText(response));
      }

      await this.respectRateLimit(response);
      const json: unknown = await response.json();
      return opts.schema.parse(json);
    }
  }

  /** Остаток кончился — ждём окна, вместо того чтобы ловить 429. */
  private async respectRateLimit(response: Response): Promise<void> {
    const remaining = Number(response.headers.get('X-RateLimit-Remaining') ?? NaN);
    if (!Number.isFinite(remaining) || remaining > this.rateLimitFloor) return;
    const reset = Number(response.headers.get('X-RateLimit-Reset') ?? NaN);
    const waitMs = Number.isFinite(reset) ? Math.max(0, reset * 1000 - Date.now()) : 1000;
    await this.sleep(Math.min(waitMs, 60_000));
  }

  /** Карточки доски постранично: 100 за запрос — это максимум API. */
  async listCards(params: { boardId?: number; externalId?: string; archived?: boolean }): Promise<Card[]> {
    const out: Card[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const page = await this.request('GET', '/cards', {
        query: {
          board_id: params.boardId,
          external_id: params.externalId,
          archived: params.archived === undefined ? undefined : String(params.archived),
          limit,
          offset,
        },
        schema: CardListSchema,
      });
      out.push(...page);
      if (page.length < limit) return out;
    }
  }

  /**
   * Точность серверного фильтра `external_id` не задокументирована, поэтому
   * совпадение перепроверяется на клиенте. Несколько точных совпадений — это
   * уже сломанная идемпотентность, и молча брать первое нельзя.
   */
  async findCardByExternalId(externalId: string, boardId?: number): Promise<Card | null> {
    const found = await this.listCards({ externalId, boardId });
    const exact = found.filter((c) => c.external_id !== null && String(c.external_id) === externalId);
    if (exact.length > 1) {
      throw new KaitenApiError(
        `external_id «${externalId}» найден на ${exact.length} карточках (${exact.map((c) => c.id).join(', ')})`,
        200,
        '',
      );
    }
    return exact[0] ?? null;
  }

  /** Одна карточка целиком: в списке описание может не приходить. */
  async getCard(cardId: number): Promise<Card> {
    return this.request('GET', `/cards/${cardId}`, { schema: CardSchema });
  }

  async createCard(payload: CardPayload): Promise<Card> {
    return this.request('POST', '/cards', {
      body: { text_format_type_id: 1, ...payload },
      schema: CardSchema,
    });
  }

  async updateCard(cardId: number, patch: Partial<CardPayload>): Promise<Card> {
    return this.request('PATCH', `/cards/${cardId}`, { body: patch, schema: CardSchema });
  }

  /**
   * Связь «эпик → story»: `POST /cards/{card_id}/children` с телом
   * `{ card_id: <id ребёнка> }` — проверено по документации 23.09.2026. На
   * живом аккаунте вызов ещё не гонялся, поэтому падение связи не валит
   * заливку, а пишется в отчёт.
   */
  async addChild(parentCardId: number, childCardId: number): Promise<unknown> {
    return this.request('POST', `/cards/${parentCardId}/children`, {
      body: { card_id: childCardId },
      schema: z.unknown(),
    });
  }

  /**
   * Чек-лист карточки и его пункты — по документации 23.09.2026:
   * `POST /cards/{card_id}/checklists {name}`, `POST /checklists/{id}/items
   * {text, checked, sort_order}`.
   */
  async createChecklist(cardId: number, name: string, sortOrder: number): Promise<{ id: number }> {
    return this.request('POST', `/cards/${cardId}/checklists`, {
      body: { name, sort_order: sortOrder },
      schema: z.object({ id: z.number() }).passthrough(),
    });
  }

  async addChecklistItem(checklistId: number, item: { text: string; checked: boolean }, sortOrder: number): Promise<unknown> {
    return this.request('POST', `/checklists/${checklistId}/items`, {
      body: { text: item.text, checked: item.checked, sort_order: sortOrder },
      schema: z.unknown(),
    });
  }

  /**
   * Отметка и текст пункта чек-листа:
   * `PATCH /cards/{card_id}/checklists/{checklist_id}/items/{id}` — проверено
   * живьём 29.09 (перечитыванием: и `checked`, и `text`).
   */
  async updateChecklistItem(cardId: number, checklistId: number, itemId: number, patch: { checked?: boolean; text?: string }): Promise<unknown> {
    return this.request('PATCH', `/cards/${cardId}/checklists/${checklistId}/items/${itemId}`, { body: patch, schema: z.unknown() });
  }

  /**
   * Комментарий к карточке: `POST /cards/{card_id}/comments {text}` — по
   * документации, проверено живьём 29.09: комментарий `type` 1, текст
   * сохраняется как отправлен. Как он отображается (markdown ли) — не смотрели.
   */
  async addComment(cardId: number, text: string): Promise<unknown> {
    return this.request('POST', `/cards/${cardId}/comments`, { body: { text }, schema: z.unknown() });
  }

  // ── Структура аккаунта: чтение и создание для `setup` ─────────────────────
  // Пути и обязательные поля проверены по документации 23.09.2026:
  // POST /spaces {title}; POST /spaces/{id}/boards {title, columns[{title,type}]}
  // (без columns/lanes создаются колонка и дорожка по умолчанию, пустой массив —
  // ошибка); POST /boards/{id}/columns {title, type}; POST /card-types
  // {name, letter, color 2–25}; POST /company/custom-properties {name, type};
  // POST /company/custom-properties/{id}/select-values {value}.

  // ── Только чтение для ночного бэкапа (`kaiten-backup.ts`): ответ — как есть ─

  /** Комментарии карточки (живьём 29.09: массив, у комментария `text`, `author`, `created`). */
  async listComments(cardId: number): Promise<unknown[]> {
    return this.request('GET', `/cards/${cardId}/comments`, { schema: z.array(z.unknown()) });
  }

  /** Ограничения пространства (не документировано, формат снят с живого аккаунта 28.09). */
  async listRestrictions(spaceId: number): Promise<unknown[]> {
    return this.request('GET', `/spaces/${spaceId}/restrictions`, { schema: z.array(z.unknown()) });
  }

  async listSpaces(): Promise<Space[]> {
    return this.request('GET', '/spaces', { schema: z.array(SpaceSchema) });
  }

  async createSpace(title: string): Promise<unknown> {
    return this.request('POST', '/spaces', { body: { title }, schema: z.unknown() });
  }

  /** Доски пространства — сразу с колонками и дорожками. */
  async listBoards(spaceId: number): Promise<Board[]> {
    return this.request('GET', `/spaces/${spaceId}/boards`, { schema: z.array(BoardSchema) });
  }

  async createBoard(spaceId: number, title: string, columns: Array<{ title: string; type: 1 | 2 | 3 }>): Promise<unknown> {
    const body = { title, columns: columns.map((c, i) => ({ ...c, sort_order: i + 1 })) };
    return this.request('POST', `/spaces/${spaceId}/boards`, { body, schema: z.unknown() });
  }

  async createColumn(boardId: number, column: { title: string; type: 1 | 2 | 3; sort_order: number }): Promise<unknown> {
    return this.request('POST', `/boards/${boardId}/columns`, { body: column, schema: z.unknown() });
  }

  async listCardTypes(): Promise<CardType[]> {
    return this.request('GET', '/card-types', { query: { limit: 100 }, schema: z.array(CardTypeSchema) });
  }

  async createCardType(type: { name: string; letter: string; color: number }): Promise<CardType> {
    return this.request('POST', '/card-types', { body: type, schema: CardTypeSchema });
  }

  async getCardType(id: number): Promise<CardType> {
    return this.request('GET', `/card-types/${id}`, { schema: CardTypeSchema });
  }

  /**
   * Шаблон описания и поля типа. Проверено живьём 28.09.2026: `PATCH` без
   * одного из `letter/name/color/properties/card_properties` отвечает 400, а
   * `description_template`, которого нет в схеме запроса документации, с
   * `name` принимается и сохраняется. Поэтому `name` передаётся всегда.
   */
  async updateCardType(
    id: number,
    patch: { name: string; description_template?: string; card_properties?: Array<{ regular_property?: string | null; property_uid?: string | null; sort_order?: number; required?: boolean }> },
  ): Promise<CardType> {
    return this.request('PATCH', `/card-types/${id}`, { body: patch, schema: CardTypeSchema });
  }

  async listCustomProperties(): Promise<CustomProperty[]> {
    return this.request('GET', '/company/custom-properties', { schema: z.array(CustomPropertySchema) });
  }

  async createCustomProperty(property: { name: string; type: 'select' | 'string' }): Promise<CustomProperty> {
    // Строка — многострочная: «Суть» бывает в три предложения.
    const body = property.type === 'select' ? { ...property, multi_select: false, show_on_facade: true } : { ...property, multiline: true };
    return this.request('POST', '/company/custom-properties', { body, schema: CustomPropertySchema });
  }

  /** Имя и состояние поля (`active`/`inactive`); тип через `PATCH` не меняется. */
  async updateCustomProperty(id: number, patch: { name?: string; condition?: 'active' | 'inactive' }): Promise<unknown> {
    return this.request('PATCH', `/company/custom-properties/${id}`, { body: patch, schema: z.unknown() });
  }

  /** Переименование чек-листа карточки: `PATCH /cards/{card_id}/checklists/{id}`. */
  async renameChecklist(cardId: number, checklistId: number, name: string): Promise<unknown> {
    return this.request('PATCH', `/cards/${cardId}/checklists/${checklistId}`, { body: { name }, schema: z.unknown() });
  }

  async listSelectValues(propertyId: number): Promise<SelectValue[]> {
    return this.request('GET', `/company/custom-properties/${propertyId}/select-values`, {
      schema: z.array(SelectValueSchema),
    });
  }

  async createSelectValue(propertyId: number, value: string): Promise<SelectValue> {
    return this.request('POST', `/company/custom-properties/${propertyId}/select-values`, {
      body: { value },
      schema: SelectValueSchema,
    });
  }

  /**
   * Сырые ответы структуры аккаунта — по ним настраивается маппинг. Пути взяты
   * из документации, но состав полей описан не полностью, поэтому сохраняется
   * весь ответ целиком. Каждый вызов изолирован: отказ одного эндпоинта не
   * лишает снимка остального, а его статус и тело тоже попадают в снимок.
   */
  async inspectStructure(spaceId?: number, boardId?: number): Promise<Record<string, unknown>> {
    const raw = z.unknown();
    const out: Record<string, unknown> = {};
    const probe = async (key: string, path: string, query?: Record<string, string>): Promise<void> => {
      try {
        out[key] = { path, ok: true, data: await this.request('GET', path, { query, schema: raw }) };
      } catch (error) {
        out[key] =
          error instanceof KaitenApiError
            ? { path, ok: false, status: error.status, body: error.body }
            : { path, ok: false, message: String(error) };
      }
    };
    await probe('spaces', '/spaces');
    await probe('cardTypes', '/card-types', { limit: '100' });
    await probe('customProperties', '/company/custom-properties', { include_values: 'true' });
    // Варианты селекта — у каждого свойства свои: /company/custom-properties/{id}/select-values.
    // Общий путь /custom-property-select-values живьём отвечает 404.
    const props = out.customProperties as { ok: boolean; data?: unknown } | undefined;
    const selects = z
      .array(z.object({ id: z.number(), type: z.string().optional() }).passthrough())
      .safeParse(props?.ok ? props.data : []);
    for (const p of selects.success ? selects.data.filter((x) => x.type === 'select') : []) {
      await probe(`selectValues_${p.id}`, `/company/custom-properties/${p.id}/select-values`);
    }
    if (spaceId !== undefined) await probe('boards', `/spaces/${spaceId}/boards`);
    if (boardId !== undefined) await probe('columns', `/boards/${boardId}/columns`);
    return out;
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('Retry-After') ?? NaN);
  if (Number.isFinite(retryAfter)) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(2 ** attempt * 500, 30_000);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
