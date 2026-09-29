/**
 * Формат задачи v2: одна таблица полей, из которой выводятся всё остальное —
 * порядок ключей в файле, обязательность, владелец поля и zod-схема.
 *
 * Источник — решения владельца 23–25.09.2026 (п. 10 в `PROMPT.md`), они
 * сильнее примера frontmatter в story `export-csv`: там ещё нет `summary`,
 * `created_by`, `created_via`, а `priority`/`planning` выглядят обычными полями.
 *
 * ВЛАДЕЛЬЦЫ (у каждого поля ровно один, Q1):
 *   · `file`   — пишет автор задачи (человек или агент) в файле;
 *   · `cli`    — ставит CLI `kaiten`, руками не правится;
 *   · `kaiten` — поле Kaiten, в файле только зеркало; агенту менять нельзя.
 *                Новая задача агента приходит без них (без приоритета до
 *                разбора). Исключения — `type` и `status`: начальное значение
 *                даёт файл (тип обязателен, статус агента — `inbox`), дальше
 *                тип меняют в Kaiten (решение 9), а статус — Kaiten и
 *                команды CLI (start/review/done/block/cancel), сначала в
 *                карточке (29.09: интеграции с GitHub нет).
 *
 * Схема строгая (`strict`): формат наш, незнакомый ключ — ошибка, а не
 * «прочитаем, что поймём». `passthrough()` по AGENTS.md — только для ответов
 * Kaiten, чья структура нам неизвестна.
 */

import { z } from 'zod';

export const TASK_TYPES = ['epic', 'story', 'tech', 'bug', 'spike'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const STATUSES = ['inbox', 'backlog', 'ready', 'in-progress', 'review', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof STATUSES)[number];

/** Закрытая задача лежит в `archive/YYYY-MM/`, остальные — в `active/` (Q42). */
export const CLOSED_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'pn'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CREATED_VIA = ['agent', 'human'] as const;

export type FieldOwner = 'file' | 'cli' | 'kaiten';

/** ULID: 26 символов Crockford base32, первый — не больше 7 (48 бит времени). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Ссылка на карточку. Ключей вида `PRJ-123` пока нет (у пространств
 * `key = null`, проверено 25.09.2026), поэтому до их появления допустим и
 * числовой id карточки. Решение, чем ссылаться, — за владельцем.
 */
const TRACKER_REF_RE = /^(?:[A-Z][A-Z0-9]*-\d+|\d+)$/;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате YYYY-MM-DD');
const nonEmpty = z.string().trim().min(1, 'пустое значение');

/**
 * `epic: 71007999` без кавычек YAML читает как число, а руками его так и
 * напишут. Принимаем и приводим к строке; сериализатор запишет в кавычках.
 */
const cardIdAsString = (value: unknown): unknown => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value);

const trackerRef = z.preprocess(cardIdAsString, z.string().regex(TRACKER_REF_RE, 'ключ карточки (PRJ-123) или её числовой id'));
/** Родитель: карточка в Kaiten или ещё не выгруженный эпик по его `id`. */
const epicRef = z.preprocess(
  cardIdAsString,
  z.string().refine((v) => TRACKER_REF_RE.test(v) || ULID_RE.test(v), 'ключ карточки эпика, её числовой id или id эпика (ULID)'),
);

/**
 * Блок планирования — зеркало полей Kaiten. Физически отделён, чтобы правило
 * «агент сюда не пишет» проверялось сравнением одного ключа, а не
 * договорённостью (story `export-csv`).
 */
const PlanningSchema = z
  .object({
    assignee: z.string().nullable().optional(),
    delegated_to: z.string().nullable().optional(),
    due: date.nullable().optional(),
    estimate_days: z.number().nonnegative().nullable().optional(),
    /** Необязательное поле школы globex. */
    phase: z.string().nullable().optional(),
  })
  .strict();

interface FieldSpec {
  owner: FieldOwner;
  /** Обязательно ли в готовом файле (после `kaiten new`). У `repo` — кроме эпика, см. схему. */
  required: boolean;
  schema: z.ZodType;
}

/**
 * Порядок строк таблицы = порядок ключей в файле. Сначала то, что читают
 * глазами (идентичность и суть), потом служебное CLI, в конце зеркала Kaiten
 * и хеш. Менять порядок — значит переписать diff у всех файлов разом.
 */
export const FIELDS = {
  id: { owner: 'cli', required: true, schema: z.string().regex(ULID_RE, 'ULID из 26 символов, его ставит CLI') },
  tracker: { owner: 'cli', required: false, schema: trackerRef },
  title: { owner: 'file', required: true, schema: nonEmpty },
  summary: { owner: 'file', required: true, schema: nonEmpty },
  type: { owner: 'kaiten', required: true, schema: z.enum(TASK_TYPES) },
  status: { owner: 'kaiten', required: true, schema: z.enum(STATUSES) },
  repo: { owner: 'file', required: false, schema: nonEmpty },
  epic: { owner: 'file', required: false, schema: epicRef },
  related: { owner: 'file', required: false, schema: z.array(nonEmpty) },
  priority: { owner: 'kaiten', required: false, schema: z.enum(PRIORITIES) },
  team: { owner: 'kaiten', required: false, schema: nonEmpty },
  created: { owner: 'cli', required: true, schema: date },
  created_by: { owner: 'cli', required: true, schema: nonEmpty },
  // Кто завёл задачу — агент или человек — отмечает CLI при `kaiten new` со слов
  // агента. У задач, перенесённых из старых форматов, поля нет: угадывать по
  // истории git владелец запретил (28.09.2026).
  created_via: { owner: 'cli', required: false, schema: z.enum(CREATED_VIA) },
  updated: { owner: 'cli', required: true, schema: date },
  planning: { owner: 'kaiten', required: false, schema: PlanningSchema },
  content_hash: { owner: 'cli', required: false, schema: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'sha256:<64 hex>') },
} as const satisfies Record<string, FieldSpec>;

export type FieldName = keyof typeof FIELDS;
export const FIELD_ORDER = Object.keys(FIELDS) as FieldName[];

export function fieldsOwnedBy(owner: FieldOwner): FieldName[] {
  return FIELD_ORDER.filter((name) => FIELDS[name].owner === owner);
}

type Shape = { [K in FieldName]: (typeof FIELDS)[K]['required'] extends true ? (typeof FIELDS)[K]['schema'] : z.ZodOptional<(typeof FIELDS)[K]['schema']> };

function buildShape(): Shape {
  const shape: Record<string, z.ZodType> = {};
  for (const name of FIELD_ORDER) {
    const spec: FieldSpec = FIELDS[name];
    // Пустое необязательное поле (`epic:`) YAML отдаёт как null — это «нет значения».
    shape[name] = spec.required ? spec.schema : z.preprocess((v) => (v === null ? undefined : v), spec.schema.optional());
  }
  return shape as Shape;
}

export const FrontmatterSchema = z
  .object(buildShape())
  .strict()
  .superRefine((fm, ctx) => {
    if (fm.type !== 'epic' && fm.repo === undefined) {
      ctx.addIssue({ code: 'custom', path: ['repo'], message: 'обязательно для всех типов, кроме эпика' });
    }
    // Уровней два: эпик → задача (решение 7). У эпика родителя нет.
    if (fm.type === 'epic' && fm.epic !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['epic'], message: 'у эпика не бывает родителя: уровней два, эпик → задача' });
    }
  });

export type Frontmatter = z.infer<typeof FrontmatterSchema>;
