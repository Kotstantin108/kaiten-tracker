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
 * значения каталога; значения селектов отдельно — `/custom-property-select-values`).
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
  })
  .passthrough();

export type Card = z.infer<typeof CardSchema>;

const CardListSchema = z.array(CardSchema);

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
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-kaiten-Client': 'kaiten-tracker-import',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

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
    await probe('selectValues', '/custom-property-select-values');
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
