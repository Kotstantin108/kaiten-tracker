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
 *   · `PATCH /cards/{id} {condition: 3}` — удаление через правку;
 *   · файл по числовому id карточки ложится с постоянной публичной ссылкой —
 *     загрузка только по UUID; путь в имени Kaiten отрезает, а переименовать
 *     или удалить файл агент не может — имя без «/» и «\»;
 *   · в документ — только картинка и только по UUID документа.
 */

type Body = Record<string, unknown> | null;

interface Rule {
  method: 'GET' | 'POST' | 'PATCH';
  path: RegExp;
  /** Проверка тела записи; строка — причина отказа. */
  check?: (body: Body) => string | null;
  /** Тело — файл формой (`multipart/form-data`), а не JSON. */
  form?: (form: FormData) => string | null;
}

const ID = '[0-9]+';
const UID = '[0-9a-zA-Z-]+';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const re =(pattern: string): RegExp => new RegExp(`^${pattern}$`);

/** Поля карточки, которых агент не трогает никогда: удаление, архив, сроки, владелец. */
const CARD_FORBIDDEN = ['condition', 'archived', 'due_date', 'due_date_time_present', 'owner_id', 'responsible_id', 'board_id'];
/** Больше — не пускаем: и страница загрузки, и инструмент ограничены этим же или меньшим. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** При создании можно поставить срок (его требуют правила типа), но не время и не владельца. */
const CREATE_FORBIDDEN = CARD_FORBIDDEN.filter((key) => key !== 'board_id' && key !== 'due_date');

function oneFile(form: FormData): string | null {
  const keys = [...form.keys()];
  if (keys.length !== 1 || keys[0] !== 'file') return 'в форме — только поле file';
  const file = form.get('file');
  if (!(file instanceof Blob)) return 'file — не файл';
  if (file.size > MAX_UPLOAD_BYTES) return 'файл больше 10 МБ';
  const name = file instanceof File ? file.name : '';
  if (!name.trim() || /[/\\]/.test(name)) return 'имя файла пустое или с «/», «\\»';
  return null;
}

/** В документ — только картинка: другие файлы документ не показывает, а видео файлом Kaiten не принимает. */
function oneImage(form: FormData): string | null {
  const problem = oneFile(form);
  if (problem) return problem;
  const file = form.get('file');
  const name = file instanceof File ? file.name : '';
  if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) return 'в документ — только картинка png, jpg, webp или gif';
  return null;
}

/** Поля документа, которых агент не трогает: доступ, публикация, архив, восстановление, копирование. */
const DOCUMENT_FORBIDDEN = ['access', 'public', 'published_version', 'slug', 'archived', 'backup_version', 'clone_uid', 'clone_version', 'key'];

function forbidKeys(keys: readonly string[]): (body: Body) => string | null {
  return (body) => {
    const found = keys.filter((key) => body !== null && key in body);
    return found.length > 0 ? `запрещённые поля: ${found.join(', ')}` : null;
  };
}

const RULES: readonly Rule[] = [
  { method: 'POST', path: re('/cards'), check: forbidKeys(CREATE_FORBIDDEN) },
  { method: 'PATCH', path: re(`/cards/${ID}`), check: forbidKeys(CARD_FORBIDDEN) },
  { method: 'POST', path: re(`/cards/${ID}/comments`) },
  { method: 'POST', path: re(`/cards/${ID}/checklists`) },
  { method: 'POST', path: re(`/checklists/${ID}/items`) },
  { method: 'PATCH', path: re(`/cards/${ID}/checklists/${ID}/items/${ID}`), check: forbidKeys(['condition', 'deleted']) },
  { method: 'POST', path: re(`/cards/${ID}/children`) },
  { method: 'POST', path: re(`/cards/${ID}/blockers`) },
  { method: 'POST', path: re(`/cards/${ID}/tags`) },
  { method: 'POST', path: re(`/cards/${ID}/external-links`) },
  { method: 'POST', path: re(`/cards/${UUID}/files`), form: oneFile },
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
  // Картинка в документ — по UUID документа и одним файлом; переименовать или удалить файл агент не может.
  { method: 'POST', path: re(`/documents/${UUID}/files`), form: oneImage },
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
  if (rule.form) return rawBody instanceof FormData ? rule.form(rawBody) : 'файл — только формой';
  if (rawBody instanceof FormData) return 'форма здесь не принимается';
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
