/**
 * Заслонка запросов в Kaiten — последний рубеж агентского сервера.
 *
 * Инструменты сервера проверяют правила сами, но «агент не удаляет» не должно
 * держаться на безошибочности каждого инструмента. Поэтому `fetch`, который
 * получает клиент Kaiten, пропускает только разрешённые метод и путь, а в теле
 * записи — только безопасные поля. Всё остальное — отказ до сети.
 *
 * Почему именно так (проверено живьём):
 *   · `DELETE` у документов безвозвратен, корзины нет;
 *   · `POST /documents/{uid}/users {email}` с незнакомой почтой заводит
 *     пользователя компании и шлёт приглашение — выдача доступа запрещена целиком;
 *   · `POST /documents` без родителя кладёт документ в корень компании;
 *     `clone_uid` кладёт копию рядом с источником, игнорируя родителя;
 *   · `PATCH /cards/{id} {condition: 3}` — удаление через правку.
 */

type Body = Record<string, unknown> | null;

interface Rule {
  method: 'GET' | 'POST' | 'PATCH';
  path: RegExp;
  /** Проверка тела записи; строка — причина отказа. */
  check?: (body: Body) => string | null;
}

const ID = '[0-9]+';
const UID = '[0-9a-zA-Z-]+';
const re = (pattern: string): RegExp => new RegExp(`^${pattern}$`);

/** Поля карточки, которых агент не трогает никогда: удаление, архив, сроки, владелец. */
const CARD_FORBIDDEN = ['condition', 'archived', 'due_date', 'due_date_time_present', 'owner_id', 'responsible_id', 'board_id'];
/** Поля документа, которых агент не трогает: доступ, публикация, архив, восстановление, копирование. */
const DOCUMENT_FORBIDDEN = ['access', 'public', 'published_version', 'slug', 'archived', 'backup_version', 'clone_uid', 'clone_version', 'key'];

function forbidKeys(keys: readonly string[]): (body: Body) => string | null {
  return (body) => {
    const found = keys.filter((key) => body !== null && key in body);
    return found.length > 0 ? `запрещённые поля: ${found.join(', ')}` : null;
  };
}

const RULES: readonly Rule[] = [
  { method: 'POST', path: re('/cards'), check: forbidKeys(CARD_FORBIDDEN.filter((key) => key !== 'board_id')) },
  { method: 'PATCH', path: re(`/cards/${ID}`), check: forbidKeys(CARD_FORBIDDEN) },
  { method: 'POST', path: re(`/cards/${ID}/comments`) },
  { method: 'POST', path: re(`/cards/${ID}/checklists`) },
  { method: 'POST', path: re(`/checklists/${ID}/items`) },
  { method: 'PATCH', path: re(`/cards/${ID}/checklists/${ID}/items/${ID}`), check: forbidKeys(['condition', 'deleted']) },
  { method: 'POST', path: re(`/cards/${ID}/children`) },
  { method: 'POST', path: re(`/cards/${ID}/blockers`) },
  { method: 'POST', path: re(`/cards/${ID}/tags`) },
  { method: 'POST', path: re(`/cards/${ID}/external-links`) },
  // Ответственный ставится только при создании — это проверяет инструмент;
  // заслонка лишь не пускает выше роли участника карточки.
  { method: 'POST', path: re(`/cards/${ID}/members`) },
  { method: 'PATCH', path: re(`/cards/${ID}/members/${ID}`) },
  {
    method: 'POST',
    path: re('/documents'),
    check: (body) => {
      const parent = body?.parent_entity_uid;
      if (typeof parent !== 'string' || parent.trim() === '') return 'документ без родителя попадает в корень компании';
      return forbidKeys(DOCUMENT_FORBIDDEN)(body);
    },
  },
  { method: 'PATCH', path: re(`/documents/${UID}`), check: forbidKeys(DOCUMENT_FORBIDDEN) },
];

/** Чтение разрешено всё, кроме настроек компании (там секреты интеграций). */
const READ_FORBIDDEN = /^\/compan(y|ies)\/(current|settings)(\/|$)|^\/companies(\/|$)/;

function parseBody(raw: RequestInit['body']): Body | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return 'invalid';
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Разрешён ли запрос; `null` — да, строка — причина отказа. */
export function checkKaitenCall(method: string, apiPath: string, rawBody?: RequestInit['body']): string | null {
  const verb = method.toUpperCase();
  if (verb === 'GET') return READ_FORBIDDEN.test(apiPath) ? 'чтение настроек компании закрыто' : null;
  const rule = RULES.find((r) => r.method === verb && r.path.test(apiPath));
  if (!rule) return `${verb} ${apiPath} агенту недоступен`;
  const body = parseBody(rawBody);
  if (body === 'invalid') return 'тело запроса — не JSON-объект';
  return rule.check ? rule.check(body) : null;
}

/** Заголовок, по которому отказ заслонки отличают от отказа Kaiten. */
export const GATE_HEADER = 'X-Agent-Gate';

function refuse(reason: string): Response {
  return new Response(JSON.stringify({ message: `Действие заблокировано: ${reason}` }), {
    status: 403,
    headers: { 'Content-Type': 'application/json', [GATE_HEADER]: '1' },
  });
}

/**
 * Обернуть `fetch`: запросы к `apiBase` проверяются по правилам, запросы на
 * другие адреса не пропускаются вовсе — сервер ходит только в Kaiten.
 *
 * Отказ — ответ 403, а не исключение: клиент Kaiten повторяет чтение при
 * сетевых исключениях, а 403 он не повторяет и сразу отдаёт ошибку.
 */
export function gatedFetch(inner: typeof fetch, apiBase: string): typeof fetch {
  const base = new URL(apiBase);
  const basePath = base.pathname.replace(/\/+$/, '');
  return async (input, init) => {
    if (input instanceof Request) return refuse('запрос в Kaiten должен идти через клиент');
    const url = new URL(input.toString());
    if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) return refuse('запрос вне Kaiten');
    const reason = checkKaitenCall(init?.method ?? 'GET', url.pathname.slice(basePath.length), init?.body);
    return reason ? refuse(reason) : inner(input, init);
  };
}
