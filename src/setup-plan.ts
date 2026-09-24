/**
 * Структура аккаунта Kaiten под схему эпика — чистая часть команды `setup`.
 *
 * ЧТО ЗАВОДИМ (Q22, Q23): пространство на продукт, в нём доска задач с
 * колонкой на каждый статус единой схемы, типы `epic/story/tech/bug/spike`,
 * селект приоритета `p0–p3/pn` и поле репозитория (Q22: репозиторий — поле
 * внутри задачи, а не проект).
 *
 * ПРАВИЛА ПЛАНА. Существующее находится по имени и не создаётся второй раз —
 * повторный прогон после `--apply` даёт пустой план. Лишнее (стандартные
 * колонки, чужие типы) не удаляется и не переименовывается: в живом аккаунте
 * мы только добавляем. Архивное считается отсутствующим — иначе маппинг
 * указал бы на то, чего в интерфейсе не видно.
 */

import { PRIORITIES, type Priority, type TaskType } from './task-source.js';
import type { Board, CardType, CustomProperty, SelectValue, Space } from './kaiten-client.js';

/** Все статусы единой схемы (Q23), а не только выводимые из старых папок. */
export const SCHEMA_STATUSES = ['inbox', 'backlog', 'ready', 'in-progress', 'blocked', 'review', 'done', 'cancelled'] as const;
export type SchemaStatus = (typeof SCHEMA_STATUSES)[number];

export interface DesiredStructure {
  space: string;
  board: string;
  /** Порядок массива — порядок колонок на доске. type: 1 очередь, 2 в работе, 3 готово. */
  columns: Array<{ status: SchemaStatus; title: string; type: 1 | 2 | 3 }>;
  types: Array<{ key: TaskType; name: string; letter: string; color: number }>;
  priority: { name: string; values: readonly Priority[] };
  repo: { name: string };
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
  priority: { name: 'Приоритет', values: PRIORITIES },
  repo: { name: 'Репозиторий' },
};

/** Текущее состояние аккаунта в том объёме, который нужен плану. */
export interface CurrentStructure {
  spaces: Space[];
  /** Доски найденного пространства; пусто, если пространства нет. */
  boards: Board[];
  cardTypes: CardType[];
  properties: CustomProperty[];
  /** Варианты селекта приоритета, если свойство уже есть. */
  priorityValues: SelectValue[];
}

export type SetupAction =
  | { kind: 'create-space'; title: string }
  | { kind: 'create-board'; title: string; columns: Array<{ title: string; type: 1 | 2 | 3 }> }
  | { kind: 'create-column'; title: string; type: 1 | 2 | 3; sortOrder: number }
  | { kind: 'create-card-type'; name: string; letter: string; color: number }
  | { kind: 'create-property'; name: string; type: 'select' | 'string' }
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

export function findProperty(current: CurrentStructure, name: string): CustomProperty | undefined {
  return current.properties.filter(alive).find((p) => same(p.name, name));
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

  const priority = findProperty(current, desired.priority.name);
  if (!priority) actions.push({ kind: 'create-property', name: desired.priority.name, type: 'select' });
  else reused.push(`свойство «${priority.name}» (${priority.id})`);
  for (const value of desired.priority.values) {
    const found = priority ? current.priorityValues.filter(alive).find((v) => same(v.value, value)) : undefined;
    if (!found) actions.push({ kind: 'create-select-value', property: desired.priority.name, value });
  }

  const repo = findProperty(current, desired.repo.name);
  if (!repo) actions.push({ kind: 'create-property', name: desired.repo.name, type: 'string' });
  else reused.push(`свойство «${repo.name}» (${repo.id})`);

  return { actions, reused, extra };
}

/** Блок `kaiten` конфига. Для селекта в значениях — id вариантов: API ждёт `id_<prop>: [<id варианта>]`. */
export interface KaitenMapping {
  boardId: number;
  laneId?: number;
  columns: Record<string, number>;
  types: Record<string, number>;
  priorityProperty: { id: number; values: Record<string, number> };
  repoProperty: { id: number };
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

  const priority = findProperty(current, desired.priority.name);
  if (!priority) missing.push(`свойство «${desired.priority.name}»`);
  const values: Record<string, number> = {};
  for (const value of desired.priority.values) {
    const found = current.priorityValues.filter(alive).find((v) => same(v.value, value));
    if (found) values[value] = found.id;
    else missing.push(`вариант приоритета «${value}»`);
  }

  const repo = findProperty(current, desired.repo.name);
  if (!repo) missing.push(`свойство «${desired.repo.name}»`);

  if (missing.length > 0 || !board || !priority || !repo) {
    throw new Error(`В аккаунте не хватает: ${missing.join(', ')}`);
  }

  // Одна дорожка на доске — её и берём; несколько — выбирать владельцу, не угадываем.
  const laneId = board.lanes.length === 1 ? board.lanes[0].id : undefined;

  return {
    boardId: board.id,
    ...(laneId === undefined ? {} : { laneId }),
    columns,
    types,
    priorityProperty: { id: priority.id, values },
    repoProperty: { id: repo.id },
  };
}
