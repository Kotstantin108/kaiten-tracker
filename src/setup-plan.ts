/**
 * Структура аккаунта Kaiten под схему эпика — чистая часть команды `setup`.
 *
 * ЧТО ЗАВОДИМ (Q22, Q23): пространство на продукт, в нём доска задач с
 * колонкой на каждый статус единой схемы, типы `epic/story/tech/bug/spike` и
 * поля-выборы: приоритет `p0–p3/pn`, репозиторий (Q22: репозиторий — поле
 * внутри задачи, а не проект) и команда — чтобы на одной доске различать
 * задачи разработки, менеджмента, маркетинга и так далее.
 *
 * ПРАВИЛА ПЛАНА. Существующее находится по имени и не создаётся второй раз —
 * повторный прогон после `--apply` даёт пустой план. Лишнее (стандартные
 * колонки, чужие типы) не удаляется и не переименовывается: в живом аккаунте
 * мы только добавляем. Архивное считается отсутствующим — иначе маппинг
 * указал бы на то, чего в интерфейсе не видно.
 *
 * ОДНОИМЁННОЕ ПОЛЕ ДРУГОГО ТИПА. Тип поля Kaiten менять не даёт (в `PATCH`
 * его нет), а «Репозиторий» сначала завели строкой. Такое поле план не
 * удаляет, а отключает и переименовывает («… (строка, отключено)»): значения
 * на карточках сохраняются, имя освобождается под поле-выбор.
 */

import { PRIORITIES, type Priority, type TaskType } from './task-source.js';
import type { Board, CardType, CustomProperty, SelectValue, Space } from './kaiten-client.js';

/** Все статусы единой схемы (Q23), а не только выводимые из старых папок. */
export const SCHEMA_STATUSES = ['inbox', 'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'cancelled'] as const;
export type SchemaStatus = (typeof SCHEMA_STATUSES)[number];

/** Поле-выбор: имя и варианты в порядке показа. */
export interface SelectSpec {
  name: string;
  values: readonly string[];
}

/** Поля-выборы схемы по ролям — роль остаётся ключом в маппинге конфига. */
export const SELECT_ROLES = ['priority', 'repo', 'team'] as const;
export type SelectRole = (typeof SELECT_ROLES)[number];

export interface DesiredStructure {
  space: string;
  board: string;
  /** Порядок массива — порядок колонок на доске. type: 1 очередь, 2 в работе, 3 готово. */
  columns: Array<{ status: SchemaStatus; title: string; type: 1 | 2 | 3 }>;
  types: Array<{ key: TaskType; name: string; letter: string; color: number }>;
  selects: Record<SelectRole, SelectSpec>;
  /** Поля, которые надо отключить и переименовать (данные на карточках остаются). */
  retire: readonly string[];
}

export const DESIRED: DesiredStructure = {
  space: 'Acme',
  board: 'Задачи',
  columns: [
    { status: 'inbox', title: 'Входящие', type: 1 },
    { status: 'backlog', title: 'Бэклог', type: 1 },
    { status: 'ready', title: 'Готово к работе', type: 1 },
    { status: 'in-progress', title: 'В работе', type: 2 },
    { status: 'blocked', title: 'Заблокировано', type: 2 },
    { status: 'review', title: 'Ревью', type: 2 },
    { status: 'done', title: 'Сделано', type: 3 },
    { status: 'cancelled', title: 'Отменено', type: 3 },
  ],
  types: [
    { key: 'epic', name: 'Epic', letter: 'E', color: 5 },
    { key: 'story', name: 'Story', letter: 'S', color: 3 },
    { key: 'tech', name: 'Tech', letter: 'T', color: 9 },
    { key: 'bug', name: 'Bug', letter: 'B', color: 2 },
    { key: 'spike', name: 'Spike', letter: 'K', color: 14 },
  ],
  selects: {
    priority: { name: 'Приоритет', values: PRIORITIES },
    // Варианты репозиториев и команд задаёт конфиг (`setup` в tracker.config.json):
    // список меняется чаще кода и решается владельцем.
    repo: { name: 'Репозиторий', values: [] },
    team: { name: 'Команда', values: [] },
  },
  retire: [],
};

/**
 * Схема для проекта из конфига: своё пространство и доска, своё поле
 * репозитория с подписями вариантов (`Acme-android`), общие приоритет и
 * команда.
 */
export function desiredForProject(input: {
  space: string;
  board: string;
  repoField: string;
  repoLabels: readonly string[];
  teams: readonly string[];
  retire?: readonly string[];
}): DesiredStructure {
  return {
    ...DESIRED,
    space: input.space,
    board: input.board,
    selects: {
      priority: DESIRED.selects.priority,
      repo: { name: input.repoField, values: input.repoLabels },
      team: { name: DESIRED.selects.team.name, values: input.teams },
    },
    retire: input.retire ?? [],
  };
}

/** Схема с вариантами из конфига: пустой список в конфиге — поле без вариантов не заводим. */
export function withSelectValues(values: Partial<Record<SelectRole, readonly string[]>>, base: DesiredStructure = DESIRED): DesiredStructure {
  const selects = { ...base.selects };
  for (const role of SELECT_ROLES) {
    const override = values[role];
    if (override) selects[role] = { ...selects[role], values: override };
  }
  return { ...base, selects };
}

/** Текущее состояние аккаунта в том объёме, который нужен плану. */
export interface CurrentStructure {
  spaces: Space[];
  /** Доски найденного пространства; пусто, если пространства нет. */
  boards: Board[];
  cardTypes: CardType[];
  properties: CustomProperty[];
  /** Варианты полей-выборов, ключ — id поля. */
  selectValues: Record<number, SelectValue[]>;
}

export type SetupAction =
  | { kind: 'create-space'; title: string }
  | { kind: 'create-board'; title: string; columns: Array<{ title: string; type: 1 | 2 | 3 }> }
  | { kind: 'create-column'; title: string; type: 1 | 2 | 3; sortOrder: number }
  | { kind: 'create-card-type'; name: string; letter: string; color: number }
  | { kind: 'retire-property'; id: number; name: string; newName: string }
  | { kind: 'create-property'; name: string; type: 'select' }
  | { kind: 'create-select-value'; property: string; value: string };

export interface SetupPlan {
  actions: SetupAction[];
  /** Что уже есть и переиспользуется — для отчёта. */
  reused: string[];
  /** Что есть в аккаунте сверх схемы и остаётся как есть. */
  extra: string[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const alive = <T extends { archived?: boolean; condition?: string }>(x: T) => x.archived !== true && (x.condition ?? 'active') === 'active';

export function findSpace(current: CurrentStructure, desired: DesiredStructure): Space | undefined {
  return current.spaces.filter(alive).find((s) => same(s.title, desired.space));
}

export function findBoard(current: CurrentStructure, desired: DesiredStructure): Board | undefined {
  return current.boards.find((b) => same(b.title, desired.board));
}

export function findCardType(current: CurrentStructure, name: string): CardType | undefined {
  return current.cardTypes.filter(alive).find((t) => same(t.name, name));
}

/** Действующее поле-выбор с таким именем; одноимённое поле другого типа сюда не попадает. */
export function findSelect(current: CurrentStructure, name: string): CustomProperty | undefined {
  return current.properties.filter(alive).find((p) => same(p.name, name) && p.type === 'select');
}

/** Действующее одноимённое поле другого типа — его надо отключить, чтобы освободить имя. */
function findClash(current: CurrentStructure, name: string): CustomProperty | undefined {
  return current.properties.filter(alive).find((p) => same(p.name, name) && p.type !== 'select');
}

function aliveValues(current: CurrentStructure, propertyId: number): SelectValue[] {
  return (current.selectValues[propertyId] ?? []).filter(alive);
}

export function planSetup(current: CurrentStructure, desired: DesiredStructure = DESIRED): SetupPlan {
  const actions: SetupAction[] = [];
  const reused: string[] = [];
  const extra: string[] = [];

  const space = findSpace(current, desired);
  if (!space) actions.push({ kind: 'create-space', title: desired.space });
  else reused.push(`пространство «${space.title}» (${space.id})`);

  const board = space ? findBoard(current, desired) : undefined;
  if (!board) {
    actions.push({ kind: 'create-board', title: desired.board, columns: desired.columns.map(({ title, type }) => ({ title, type })) });
  } else {
    reused.push(`доска «${board.title}» (${board.id})`);
    const maxSort = Math.max(0, ...board.columns.map((c) => c.sort_order ?? 0));
    let next = maxSort;
    for (const column of desired.columns) {
      const found = board.columns.find((c) => same(c.title, column.title));
      if (found) reused.push(`колонка «${found.title}» (${found.id})`);
      else actions.push({ kind: 'create-column', title: column.title, type: column.type, sortOrder: ++next });
    }
    for (const c of board.columns) {
      if (!desired.columns.some((d) => same(d.title, c.title))) extra.push(`колонка «${c.title}» (${c.id})`);
    }
  }

  for (const type of desired.types) {
    const found = findCardType(current, type.name);
    if (found) reused.push(`тип «${found.name}» (${found.id})`);
    else actions.push({ kind: 'create-card-type', name: type.name, letter: type.letter, color: type.color });
  }
  for (const t of current.cardTypes.filter(alive)) {
    if (!desired.types.some((d) => same(d.name, t.name))) extra.push(`тип «${t.name}» (${t.id})`);
  }

  // Отключаем устаревшие поля по явному списку — но не те, что нужны схеме.
  const wantedNames = SELECT_ROLES.map((r) => desired.selects[r].name);
  for (const name of desired.retire) {
    const old = current.properties.filter(alive).find((p) => same(p.name, name) && !wantedNames.some((w) => same(w, name)));
    if (old) actions.push({ kind: 'retire-property', id: old.id, name: old.name, newName: `${old.name} (${old.type ?? 'поле'}, отключено)` });
  }

  for (const role of SELECT_ROLES) {
    const spec = desired.selects[role];
    if (spec.values.length === 0) continue;
    const clash = findClash(current, spec.name);
    if (clash) {
      actions.push({ kind: 'retire-property', id: clash.id, name: clash.name, newName: `${clash.name} (${clash.type ?? 'другой тип'}, отключено)` });
    }
    const property = findSelect(current, spec.name);
    if (!property) actions.push({ kind: 'create-property', name: spec.name, type: 'select' });
    else reused.push(`поле «${property.name}» (${property.id})`);
    const have = property ? aliveValues(current, property.id) : [];
    for (const value of spec.values) {
      if (!have.some((v) => same(v.value, value))) actions.push({ kind: 'create-select-value', property: spec.name, value });
    }
  }

  return { actions, reused, extra };
}

/** Поле-выбор в маппинге: id поля и id вариантов по значению. */
export interface SelectMapping {
  id: number;
  values: Record<string, number>;
}

/** Блок `kaiten` конфига. Для селекта в значениях — id вариантов: API ждёт `id_<prop>: [<id варианта>]`. */
export interface KaitenMapping {
  boardId: number;
  laneId?: number;
  columns: Record<string, number>;
  types: Record<string, number>;
  priorityProperty: SelectMapping;
  repoProperty?: SelectMapping;
  teamProperty?: SelectMapping;
}

/**
 * Маппинг по состоянию, в котором всё уже заведено. Чего-то не хватает —
 * ошибка со списком: неполный маппинг молча положил бы карточки не туда.
 */
export function buildMapping(current: CurrentStructure, desired: DesiredStructure = DESIRED): KaitenMapping {
  const missing: string[] = [];
  const board = findSpace(current, desired) ? findBoard(current, desired) : undefined;
  if (!board) missing.push(`доска «${desired.board}»`);

  const columns: Record<string, number> = {};
  for (const column of desired.columns) {
    const found = board?.columns.find((c) => same(c.title, column.title));
    if (found) columns[column.status] = found.id;
    else missing.push(`колонка «${column.title}»`);
  }

  const types: Record<string, number> = {};
  for (const type of desired.types) {
    const found = findCardType(current, type.name);
    if (found) types[type.key] = found.id;
    else missing.push(`тип «${type.name}»`);
  }

  const selects: Partial<Record<SelectRole, SelectMapping>> = {};
  for (const role of SELECT_ROLES) {
    const spec = desired.selects[role];
    if (spec.values.length === 0) continue;
    const property = findSelect(current, spec.name);
    if (!property) {
      missing.push(`поле-выбор «${spec.name}»`);
      continue;
    }
    const values: Record<string, number> = {};
    for (const value of spec.values) {
      const found = aliveValues(current, property.id).find((v) => same(v.value, value));
      if (found) values[value] = found.id;
      else missing.push(`вариант «${value}» поля «${spec.name}»`);
    }
    selects[role] = { id: property.id, values };
  }

  if (missing.length > 0 || !board || !selects.priority) {
    throw new Error(`В аккаунте не хватает: ${missing.join(', ') || 'поля приоритета'}`);
  }

  // Одна дорожка на доске — её и берём; несколько — выбирать владельцу, не угадываем.
  const laneId = board.lanes.length === 1 ? board.lanes[0].id : undefined;

  return {
    boardId: board.id,
    ...(laneId === undefined ? {} : { laneId }),
    columns,
    types,
    priorityProperty: selects.priority,
    ...(selects.repo ? { repoProperty: selects.repo } : {}),
    ...(selects.team ? { teamProperty: selects.team } : {}),
  };
}
