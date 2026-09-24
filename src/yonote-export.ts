/**
 * Чистая часть выгрузки yonote: ссылки на вложения и документы в markdown,
 * пути документов в дереве, подсчёт чекбоксов, индекс. Ни сети, ни файлов —
 * всё проверяется тестами на строках.
 *
 * ЗАЧЕМ ПЕРЕПИСЫВАТЬ ССЫЛКИ. В markdown Outline вложение — это
 * `/api/attachments.redirect?id=<uuid>` на сервере yonote, ссылка на другой
 * документ — `/doc/<slug>-<urlId>`. После выключения yonote и то и другое
 * станет битым, поэтому обе заменяются на относительные пути внутри выгрузки.
 */

/** Ссылка на вложение, найденная в тексте документа. */
export interface AttachmentRef {
  /** UUID вложения из `attachments.redirect?id=`. */
  id: string;
  /** Ссылка ровно в том виде, в каком стоит в тексте, — её и заменяем. */
  raw: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Абсолютная (`https://<хост>/api/…`) или относительная (`/api/…`) ссылка на
 * вложение. Хост не фиксируем: у команды yonote может быть свой поддомен, а
 * ссылки, вставленные копированием, бывают и с хостом, и без.
 */
const ATTACHMENT_RE = new RegExp(
  `(?:https?://[^\\s)"'<>]+)?/api/attachments\\.redirect\\?id=(${UUID})`,
  'gi',
);

export function findAttachmentRefs(markdown: string): AttachmentRef[] {
  const seen = new Map<string, AttachmentRef>();
  for (const match of markdown.matchAll(ATTACHMENT_RE)) {
    const raw = match[0];
    if (!seen.has(raw)) seen.set(raw, { id: match[1].toLowerCase(), raw });
  }
  return [...seen.values()];
}

/**
 * Ссылка на документ: `/doc/<slug>-<urlId>`, urlId — 10 символов base62.
 * Хвост вроде `#heading` или `/edit` оставляем как есть: якорь в markdown
 * не сработает, но и не помешает.
 */
const DOC_LINK_RE = /(?:https?:\/\/[^\s)"'<>]+)?\/doc\/(?:[^\s)"'<>/#?]*-)?([A-Za-z0-9]{10})(?=[\s)"'<>/#?]|$)/g;

export interface RewriteResult {
  markdown: string;
  /** Вложения, у которых нет локального файла, — ссылка осталась прежней. */
  missingAttachments: string[];
  /** urlId документов, которых нет в выгрузке, — ссылка осталась прежней. */
  unresolvedDocLinks: string[];
}

/**
 * Переписывает ссылки на относительные пути. Документы лежат в `docs/`,
 * вложения — в `attachments/`, поэтому из документа вложение — это
 * `../attachments/<файл>`, а соседний документ — `./<id>.md`.
 */
export function rewriteLinks(
  markdown: string,
  attachmentFiles: ReadonlyMap<string, string>,
  docIdByUrlId: ReadonlyMap<string, string>,
): RewriteResult {
  const missingAttachments = new Set<string>();
  const unresolvedDocLinks = new Set<string>();

  let out = markdown.replace(ATTACHMENT_RE, (raw: string, id: string) => {
    const file = attachmentFiles.get(id.toLowerCase());
    if (!file) {
      missingAttachments.add(id.toLowerCase());
      return raw;
    }
    return `../attachments/${file}`;
  });

  out = out.replace(DOC_LINK_RE, (raw: string, urlId: string) => {
    const docId = docIdByUrlId.get(urlId);
    if (!docId) {
      unresolvedDocLinks.add(urlId);
      return raw;
    }
    return `./${docId}.md`;
  });

  return { markdown: out, missingAttachments: [...missingAttachments], unresolvedDocLinks: [...unresolvedDocLinks] };
}

/**
 * Хосты внешних ссылок и картинок — только хосты, без путей: по ним человек
 * решает, нет ли среди «внешних» ещё одного хранилища yonote, которое тоже
 * умрёт при выключении. Пути не собираем — в них бывают имена файлов с ПДн.
 */
export function externalHosts(markdown: string): string[] {
  const hosts = new Set<string>();
  for (const match of markdown.matchAll(/https?:\/\/([^\s/)"'<>?#]+)/gi)) hosts.add(match[1].toLowerCase());
  return [...hosts].sort();
}

export interface CheckboxCount {
  open: number;
  done: number;
}

/**
 * Чекбоксы `- [ ]` / `- [x]` — то, что Outline называет задачами документа
 * (поле `tasks` в ответе API). Считаем сами, потому что у форка поле может
 * отсутствовать, а по числам видно, велись ли задачи чек-листами.
 */
export function countCheckboxes(markdown: string): CheckboxCount {
  let open = 0;
  let done = 0;
  for (const match of markdown.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm)) {
    if (match[1] === ' ') open++;
    else done++;
  }
  return { open, done };
}

/** Документ в том объёме, который нужен для пути в дереве. */
export interface TreeNode {
  id: string;
  title: string;
  parentDocumentId?: string | null;
  collectionId?: string | null;
}

/**
 * Путь документа заголовками: коллекция / родитель / … / сам документ.
 * Родитель может не попасть в выгрузку (нет прав, удалён) — тогда путь
 * обрывается пометкой, а не молча начинается с середины. Цикл в данных
 * (не должен случаться, но данные чужие) — тоже пометка, а не зависание.
 */
export function documentPath(
  doc: TreeNode,
  byId: ReadonlyMap<string, TreeNode>,
  collectionNames: ReadonlyMap<string, string>,
): string[] {
  const chain: string[] = [doc.title];
  const visited = new Set<string>([doc.id]);
  let parentId = doc.parentDocumentId ?? null;
  let root: TreeNode = doc;
  while (parentId) {
    if (visited.has(parentId)) {
      chain.unshift('[цикл в дереве]');
      break;
    }
    const parent = byId.get(parentId);
    if (!parent) {
      chain.unshift(`[родитель ${parentId} вне выгрузки]`);
      break;
    }
    visited.add(parentId);
    chain.unshift(parent.title);
    root = parent;
    parentId = parent.parentDocumentId ?? null;
  }
  const collectionId = root.collectionId ?? doc.collectionId ?? null;
  chain.unshift(collectionId ? (collectionNames.get(collectionId) ?? `[коллекция ${collectionId}]`) : '[без коллекции]');
  return chain;
}

/**
 * Свойство базы данных yonote. У Outline баз нет — это надстройка форка:
 * документ `type: database` держит схему в `properties` (ключ — id свойства),
 * строки — документы `type: row` с `parentDocumentId` на базу и значениями в
 * `values` (ключ — id свойства, значение — строка). Форма снята с живого
 * аккаунта 23.09.2026, в документации её нет.
 */
export interface DatabaseProperty {
  id?: string;
  type?: string;
  title?: string;
  options?: Array<{ id?: string; label?: string; value?: string }> | null;
}

export interface DatabaseRow {
  id: string;
  title: string;
  numId?: number | null;
  values?: Record<string, unknown> | null;
}

/**
 * Значение ячейки для человека: у select/status/person в ячейке id варианта
 * (или его `value`), подпись берём из вариантов. Не нашли — оставляем как
 * есть: сырое значение лучше пустоты, а сырой JSON всё равно лежит рядом.
 */
export function cellLabel(property: DatabaseProperty | undefined, raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const options = property?.options ?? [];
  const byKey = (key: string) => options.find((o) => o.id === key || o.value === key)?.label;
  // people на живом аккаунте — массив строк; элемент без варианта остаётся как есть.
  if (Array.isArray(raw)) return raw.map((item) => (typeof item === 'string' ? (byKey(item) ?? item) : JSON.stringify(item))).join(', ');
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (options.length === 0) return text;
  const direct = byKey(text);
  if (direct !== undefined) return direct;
  // Несколько вариантов (people) — через запятую.
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => byKey(p) !== undefined)) return parts.map((p) => byKey(p)).join(', ');
  return text;
}

/** Таблица базы в CSV: номер, заголовок, id строки и по колонке на свойство. */
export function databaseCsv(properties: Record<string, DatabaseProperty>, rows: DatabaseRow[]): string {
  const propIds = Object.keys(properties).filter((id) => id !== 'title');
  const header = ['numId', 'title', 'documentId', ...propIds.map((id) => properties[id].title || id)];
  const lines = [header];
  const sorted = [...rows].sort((a, b) => (a.numId ?? 0) - (b.numId ?? 0) || a.id.localeCompare(b.id));
  for (const row of sorted) {
    lines.push([
      row.numId === null || row.numId === undefined ? '' : String(row.numId),
      row.title,
      row.id,
      ...propIds.map((id) => cellLabel(properties[id], row.values?.[id])),
    ]);
  }
  return `${lines.map((cells) => cells.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Расширение файла вложения по Content-Type. Незнакомый тип — `.bin`: файл
 * всё равно сохранится, а тип записан в индекс.
 */
export function extensionFor(contentType: string | null): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
  };
  return known[type] ?? '.bin';
}
