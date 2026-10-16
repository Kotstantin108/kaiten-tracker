/**
 * Ограничения Kaiten (restrictions), пройденные сервером до записи.
 *
 * Kaiten сам отказывает по ограничению — и через API тоже, — но одним
 * `error_text` и только после попытки. Сервер проходит те же условия заранее,
 * чтобы отказать полным списком: каких полей не хватает и что они значат.
 *
 * Семантика (снята с правил интерфейса и проверена живьём 15.10.2026):
 * ограничение срабатывает на действие (`creation` — доска, `movement` —
 * колонка), если выполнены все его условия; оператор `ne` — отрицание.
 * `prevCardPath` перечисляет колонки, ИЗ которых переносить нельзя;
 * `childCardsDone` с `eq` выполнено, пока дочерние карточки НЕ готовы. Условие,
 * которое сервер не умеет проверить, даёт «неизвестно»: такое ограничение
 * остаётся на Kaiten, и его отказ агент получит после попытки.
 */

import { z } from 'zod';

const PathSchema = z.object({ boardId: z.number().optional(), columnId: z.number().optional(), spaceId: z.number().optional() }).passthrough();

const ConditionSchema = z
  .object({
    type: z.string(),
    operator: z.string().default('eq'),
    data: z
      .object({
        comparator: z.string().optional(),
        paths: z.array(z.object({ path: PathSchema }).passthrough()).optional(),
        properties: z
          .array(z.object({ propertyKey: z.string(), comparator: z.string(), value: z.unknown().optional() }).passthrough())
          .optional(),
        typeIds: z.array(z.number()).optional(),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();

export const RestrictionSchema = z
  .object({
    name: z.string().default(''),
    status: z.string().default('active'),
    error_text: z.string().nullable().optional(),
    conditions: z.array(ConditionSchema).default([]),
    restrictions: z.array(z.object({ type: z.string(), data: z.object({ path: PathSchema }).passthrough() }).passthrough()).default([]),
  })
  .passthrough();
export type Restriction = z.infer<typeof RestrictionSchema>;

/** Состояние карточки, по которому проверяются условия. */
export interface CardState {
  typeId: number;
  /** Колонка, из которой переносят; при создании — нет. */
  fromColumnId: number | null;
  properties: Record<string, unknown>;
  /** Все дочерние карточки готовы; `undefined` — не вычислено. */
  childrenDone?: boolean;
}

export type Verdict = 'blocks' | 'passes' | 'unknown';

export function parseRestrictions(raw: unknown[]): Restriction[] {
  const out: Restriction[] = [];
  for (const item of raw) {
    const parsed = RestrictionSchema.safeParse(item);
    if (parsed.success && parsed.data.status === 'active') out.push(parsed.data);
  }
  return out;
}

/** Ограничения, которые касаются действия над этой доской или колонкой. */
export function applicable(list: Restriction[], action: 'creation' | 'movement', target: { boardId: number; columnId?: number }): Restriction[] {
  return list.filter((r) =>
    r.restrictions.some((x) => {
      if (x.type !== action) return false;
      const path = x.data.path;
      if (path.boardId !== undefined && path.boardId !== target.boardId) return false;
      if (action === 'movement') return path.columnId === undefined || path.columnId === target.columnId;
      return true;
    }),
  );
}

export function isSet(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

type Truth = boolean | 'unknown';

function conditionTruth(condition: Restriction['conditions'][number], state: CardState): Truth {
  const data = condition.data;
  let truth: Truth;
  switch (condition.type) {
    case 'cardProperty': {
      const checks = (data.properties ?? []).map((p): Truth => {
        if (p.comparator === 'noSet') return !isSet(state.properties[p.propertyKey]);
        if (p.comparator === 'set') return isSet(state.properties[p.propertyKey]);
        return 'unknown';
      });
      truth = combine(checks, data.comparator === 'and' ? 'and' : 'or');
      break;
    }
    case 'prevCardPath':
      truth = state.fromColumnId === null ? false : (data.paths ?? []).some((p) => p.path.columnId === state.fromColumnId);
      break;
    case 'cardType':
      truth = (data.typeIds ?? []).includes(state.typeId);
      break;
    case 'childCardsDone':
      // Живьём: «eq» запрещает перенос, пока дети не готовы.
      truth = state.childrenDone === undefined ? 'unknown' : !state.childrenDone;
      break;
    default:
      truth = 'unknown';
  }
  if (truth === 'unknown') return truth;
  return condition.operator === 'ne' ? !truth : truth;
}

function combine(values: Truth[], mode: 'and' | 'or'): Truth {
  if (values.length === 0) return 'unknown';
  if (mode === 'or') {
    if (values.includes(true)) return true;
    return values.includes('unknown') ? 'unknown' : false;
  }
  if (values.includes(false)) return false;
  return values.includes('unknown') ? 'unknown' : true;
}

/** Срабатывает ли ограничение на этом состоянии карточки. */
export function verdict(restriction: Restriction, state: CardState): Verdict {
  const truth = combine(
    restriction.conditions.map((c) => conditionTruth(c, state)),
    'and',
  );
  return truth === 'unknown' ? 'unknown' : truth ? 'blocks' : 'passes';
}

/**
 * Поля, без которых ограничение заведомо сработает: условие «поле не задано»
 * при отсутствии других условий, которые его снимают. Из них агенту
 * собирается список «заполните».
 */
export function demandedProperties(restriction: Restriction): string[] {
  const keys: string[] = [];
  for (const condition of restriction.conditions) {
    if (condition.type !== 'cardProperty' || condition.operator === 'ne') continue;
    for (const p of condition.data.properties ?? []) if (p.comparator === 'noSet') keys.push(p.propertyKey);
  }
  return keys;
}

/** Нужно ли для проверки знать, готовы ли дочерние карточки. */
export function needsChildren(list: Restriction[]): boolean {
  return list.some((r) => r.conditions.some((c) => c.type === 'childCardsDone'));
}
