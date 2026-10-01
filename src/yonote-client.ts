/**
 * Клиент yonote только на чтение.
 *
 * yonote — форк Outline (ответ `documents.list`
 * байт в байт как у Outline, компоненты Outline в CSS-бандлах), поэтому API
 * Outline-совместимый: RPC-стиль, `POST https://<хост>/api/<метод>` с JSON-телом,
 * `Authorization: Bearer <token>`, ответ `{ ok, data, pagination }`, пагинация
 * `limit` (максимум 100) и `offset`.
 *
 * ЧТО ПРОВЕРЕНО ПО ДОКУМЕНТАЦИИ OUTLINE (github.com/outline/openapi,
 * 23.09.2026): `documents.list`, `documents.drafts`, `documents.archived`,
 * `documents.deleted`, `documents.info` (поле `text` — markdown, поле `tasks`
 * `{ completed, total }`), `collections.list`, `attachments.redirect`.
 * ЧТО НЕ ПРОВЕРЕНО: какие из них живы в yonote и совпадает ли состав полей.
 * Поэтому списки опрашиваются по отдельности и отказ одного не валит выгрузку,
 * а схемы — `passthrough()` и описывают только то, что читаем.
 *
 * ПРОВЕРЕНО ЖИВЬЁМ (23.09.2026, токен без роли админа):
 *   · все пять списков живы; `documents.list` без явного `type` прячет строки
 *     баз данных (см. `YONOTE_DOCUMENT_TYPES`);
 *   · поле `text` у yonote — ПОЧТИ ГОЛЫЙ ТЕКСТ, а не markdown: на 474
 *     документах ноль ссылок `](`, таблиц, блоков кода и экранирований, хотя
 *     URL в тексте есть. Разметка, ссылки и картинки в нём потеряны;
 *   · `documents.export` не отдаёт markdown, а создаёт FileOperation
 *     (серверную операцию экспорта, как в новом Outline); статус и файл —
 *     через `fileOperations.*`, а `fileOperations.list` требует роль админа.
 *     Поэтому клиент `documents.export` не вызывает: каждый вызов — операция на
 *     сервере и, вероятно, письмо владельцу;
 *   · `comments.list` принимает `entityId`, а не `documentId`, и отвечает
 *     `data: { comments: [...] }`.
 * Полноценный markdown с вложениями — только штатным экспортом пространства
 * (решение владельца: из интерфейса под админом или `collections.export_all`
 * админским токеном).
 *
 * Клиент не вызывает ни одного метода, который что-то меняет. Токен не
 * попадает ни в сообщения об ошибках, ни в URL, и не уходит на чужой хост при
 * редиректе вложения в хранилище.
 */

import { z } from 'zod';

export const YonoteDocumentSchema = z
  .object({
    id: z.string(),
    urlId: z.string().optional(),
    url: z.string().optional(),
    title: z.string().default(''),
    text: z.string().optional(),
    collectionId: z.string().nullable().optional(),
    parentDocumentId: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    archivedAt: z.string().nullable().optional(),
    deletedAt: z.string().nullable().optional(),
    template: z.boolean().optional(),
    createdBy: z.object({ id: z.string(), name: z.string().optional() }).passthrough().nullable().optional(),
    updatedBy: z.object({ id: z.string(), name: z.string().optional() }).passthrough().nullable().optional(),
    tasks: z.object({ completed: z.number(), total: z.number() }).passthrough().nullable().optional(),
    // Поля форка, которых нет в Outline (сняты с живого аккаунта 23.09.2026):
    // тип документа, номер строки, схема базы и значения строки.
    type: z.string().optional(),
    numId: z.number().nullable().optional(),
    commentsCount: z.number().nullable().optional(),
    properties: z
      .record(
        z.string(),
        z
          .object({
            id: z.string().optional(),
            type: z.string().optional(),
            title: z.string().optional(),
            options: z
              .array(z.object({ id: z.string().optional(), label: z.string().optional(), value: z.string().optional() }).passthrough())
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
    values: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

/**
 * Все типы документов форка. Без явного `type` метод `documents.list` у yonote
 * НЕ отдаёт строки баз данных (`row`): на живом аккаунте 23.09.2026 — 149
 * документов по умолчанию против 438 с полным списком типов, и спрятанные 289 —
 * как раз строки баз, то есть задачи. Значения взяты из ответа валидатора
 * («type must be an array of: …»).
 */
export const YONOTE_DOCUMENT_TYPES = ['document', 'database', 'row', 'embed', 'whiteboard'] as const;

export type YonoteDocument = z.infer<typeof YonoteDocumentSchema>;

export const YonoteCollectionSchema = z
  .object({
    id: z.string(),
    name: z.string().default(''),
    url: z.string().optional(),
    archivedAt: z.string().nullable().optional(),
    deletedAt: z.string().nullable().optional(),
  })
  .passthrough();

export type YonoteCollection = z.infer<typeof YonoteCollectionSchema>;

const ListEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), pagination: z.object({ offset: z.number().optional() }).passthrough().optional() }).passthrough();

const InfoEnvelope = <T extends z.ZodType>(item: T) => z.object({ data: item }).passthrough();

export interface YonoteClientOptions {
  /** Адрес команды, например `https://acme.yonote.ru`. */
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class YonoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'YonoteApiError';
  }
}

export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string | null;
}

const PAGE = 100;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class YonoteClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  requestCount = 0;

  constructor(options: YonoteClientOptions) {
    const withScheme = /^https?:\/\//.test(options.baseUrl) ? options.baseUrl : `https://${options.baseUrl}`;
    this.origin = new URL(withScheme).origin;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 5;
  }

  get baseUrl(): string {
    return this.origin;
  }

  /** Повторяет 429 и 5xx с паузой; остальные ошибки — сразу наверх. */
  private async send(method: string, url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      const response = await this.fetchImpl(url, init);
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.maxRetries) {
          throw new YonoteApiError(`${method}: ${response.status} после ${attempt + 1} попыток`, response.status, await safeText(response));
        }
        await this.sleep(retryDelayMs(response, attempt));
        continue;
      }
      return response;
    }
  }

  private async rpc<T>(method: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const response = await this.send(method, `${this.origin}/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new YonoteApiError(`${method}: ${response.status}`, response.status, await safeText(response));
    return schema.parse(await response.json());
  }

  /**
   * Все страницы списка. Идём, пока страница полная, а не по `nextPath`:
   * у форка его может не быть, а полная страница однозначно значит «есть ещё».
   */
  async listAll<T>(method: string, item: z.ZodType<T>, body: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = [];
    const envelope = ListEnvelope(item);
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.rpc(method, { ...body, limit: PAGE, offset }, envelope);
      out.push(...(page.data as T[]));
      if (page.data.length < PAGE) return out;
    }
  }

  async authInfo(): Promise<unknown> {
    return (await this.rpc('auth.info', {}, InfoEnvelope(z.unknown()))).data;
  }

  async collections(): Promise<YonoteCollection[]> {
    return this.listAll('collections.list', YonoteCollectionSchema);
  }

  /** Список документов одним из методов `documents.list|drafts|archived|deleted`. */
  async documents(method: string, body: Record<string, unknown> = {}): Promise<YonoteDocument[]> {
    return this.listAll(method, YonoteDocumentSchema, body);
  }

  async documentInfo(id: string): Promise<YonoteDocument> {
    return (await this.rpc('documents.info', { id }, InfoEnvelope(YonoteDocumentSchema))).data;
  }

  /**
   * Комментарии документа. У yonote параметр называется `entityId`, а не
   * `documentId`, как у Outline: без него сервер отвечает 400 «Either entityId
   * or shareId must be provided» (проверено 23.09.2026). И ответ другой формы:
   * `data: { comments: [...] }` вместо массива в `data`.
   */
  async comments(documentId: string): Promise<unknown[]> {
    const envelope = z.object({ data: z.object({ comments: z.array(z.unknown()) }).passthrough() }).passthrough();
    const out: unknown[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.rpc('comments.list', { entityId: documentId, limit: PAGE, offset }, envelope);
      out.push(...page.data.comments);
      if (page.data.comments.length < PAGE) return out;
    }
  }

  /**
   * Вложение по `attachments.redirect`. Редирект обрабатываем руками: сервер
   * отдаёт подписанную ссылку в хранилище, и токен туда нести нельзя — он
   * нужен только своему хосту. Относительный Location разрешаем от своего
   * origin и тогда авторизуемся.
   */
  async downloadAttachment(id: string): Promise<DownloadedFile> {
    let url = `${this.origin}/api/attachments.redirect?id=${encodeURIComponent(id)}`;
    for (let hop = 0; hop < 5; hop++) {
      const sameOrigin = new URL(url).origin === this.origin;
      const response = await this.send('attachments.redirect', url, {
        method: 'GET',
        redirect: 'manual',
        headers: sameOrigin ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location');
        if (!location) throw new YonoteApiError(`attachments.redirect: ${response.status} без Location`, response.status, '');
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        throw new YonoteApiError(`attachments.redirect: ${response.status}`, response.status, await safeText(response));
      }
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('Content-Type') };
    }
    throw new YonoteApiError('attachments.redirect: больше 5 редиректов', 0, '');
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('Retry-After') ?? NaN);
  if (Number.isFinite(retryAfter)) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(2 ** attempt * 500, 30_000);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}
