/**
 * Файл задачи v2: `---`-frontmatter на YAML + markdown-тело.
 *
 * Сериализатор пишет ключи в порядке таблицы `FIELDS`, а не в порядке ключей
 * пришедшего объекта: так диффы детерминированы, кто бы ни правил файл.
 * `serialize(parse(x)) === x` для файла в каноническом виде — на этом стоят
 * тесты и линтер (неканонический файл — предупреждение).
 *
 * YAML 1.2, схема `core`: даты `2026-09-16` остаются строками, а не `Date`.
 */

import { createHash } from 'node:crypto';

import { parseDocument, stringify } from 'yaml';

import { FIELD_ORDER, FIELDS, fieldsOwnedBy, type FieldName, type Frontmatter } from './schema.js';

export interface RawTaskDocument {
  /** Разобранный YAML как есть, до проверки схемой. */
  data: unknown;
  body: string;
}

export class TaskParseError extends Error {}

const OPEN = '---\n';
const CLOSE_RE = /^---[ \t]*$/m;

export function parseTaskDocument(text: string): RawTaskDocument {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(OPEN)) throw new TaskParseError('файл должен начинаться с frontmatter `---`');

  const rest = normalized.slice(OPEN.length);
  const close = CLOSE_RE.exec(rest);
  if (!close) throw new TaskParseError('не найдена закрывающая строка `---` frontmatter');

  const yamlText = rest.slice(0, close.index);
  const afterClose = close.index + close[0].length;
  const body = rest.slice(rest[afterClose] === '\n' ? afterClose + 1 : afterClose);

  const doc = parseDocument(yamlText, { schema: 'core', uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) throw new TaskParseError(`frontmatter не разбирается: ${doc.errors[0].message}`);
  const data: unknown = doc.toJS() ?? {};
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TaskParseError('frontmatter должен быть словарём ключ: значение');
  }
  return { data, body };
}

const PLANNING_ORDER = ['assignee', 'delegated_to', 'due', 'estimate_days', 'phase'] as const;

function ordered(fm: Frontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of FIELD_ORDER) {
    const value = fm[name];
    if (value === undefined) continue;
    if (name === 'planning' && fm.planning) {
      const planning: Record<string, unknown> = {};
      for (const key of PLANNING_ORDER) if (fm.planning[key] !== undefined) planning[key] = fm.planning[key];
      out[name] = planning;
      continue;
    }
    out[name] = value;
  }
  return out;
}

export function serializeTaskDocument(fm: Frontmatter, body: string): string {
  // lineWidth 0 — без переноса длинных строк: «Суть» и заголовок остаются одной строкой.
  const yamlText = stringify(ordered(fm), { lineWidth: 0, minContentWidth: 0 });
  return `${OPEN}${yamlText}---\n${body}`;
}

/**
 * Хеш содержимого для сверки с Kaiten: меняется только тогда, когда поменялось
 * то, чем владеет файл (поля `file` и тело). В поле `content_hash` его пишет
 * только синхронизация с Kaiten — «это содержимое карточка уже получила»;
 * команды записи и конвертер поле не трогают, поэтому `content_hash` ≠
 * пересчитанному = «карточку нужно обновить» (Q32). Служебные поля CLI (`updated`,
 * `tracker`, сам `content_hash`) и зеркала Kaiten в него не входят — иначе
 * каждая сверка сама порождала бы «изменение».
 *
 * Отличается от маркера `<!-- acme-sync:… -->` в `plan.ts`: тот считается
 * по готовому описанию карточки и ловит правку описания в интерфейсе Kaiten,
 * этот — по файлу и ловит правку файла.
 */
const LATE_FILE_FIELDS: readonly FieldName[] = ['domain'];

export function contentHash(fm: Frontmatter, body: string): string {
  // Поле, добавленное в формат позже, входит в хеш, только когда оно есть: иначе хеш сменился бы
  // у всех задач разом, и синхронизация перерисовала бы каждую карточку.
  const owned: Array<[FieldName, unknown]> = fieldsOwnedBy('file')
    .filter((name) => !LATE_FILE_FIELDS.includes(name) || fm[name] !== undefined)
    .map((name) => [name, fm[name] ?? null]);
  const payload = JSON.stringify({ fields: owned, body: body.replace(/\r\n/g, '\n').replace(/\s+$/, '') });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * Какие поля изменены в обход владельца: агент (и автор файла вообще) может
 * менять только поля `file`. Нужен командам записи CLI — проверить правку
 * агента до push.
 */
export function foreignFieldChanges(before: Frontmatter, after: Frontmatter): FieldName[] {
  return FIELD_ORDER.filter(
    (name) => FIELDS[name].owner !== 'file' && JSON.stringify(before[name] ?? null) !== JSON.stringify(after[name] ?? null),
  );
}
