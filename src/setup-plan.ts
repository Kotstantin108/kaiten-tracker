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
 *
 * ШАБЛОНЫ И «СУТЬ» (решение владельца 28.09.2026). У каждого типа — шаблон
 * описания по скелету формата v2 (`kaitenTemplate`) и обязательное текстовое
 * поле «Суть»: «Суть» живёт в поле, а не блоком в описании. Типы общие на
 * компанию, поэтому это действует во всех проектах. Шаблон, который человек
 * поменял в интерфейсе, план перезапишет: источник шаблонов — этот код.
 */

import type { AssessVerdict } from './core/schema.js';
import { kaitenTemplate } from './core/skeleton.js';
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
  /** Текстовое поле «Суть»: обязательное во всех типах; `null` — не заводим. */
  summary: { name: string } | null;
  /** Ставить ли типам шаблоны описаний по скелету формата v2. */
  templates: boolean;
  /**
   * Стандартные поля, которые тип предлагает заполнить, но не требует:
   * «Срок» (`due_date`) — решение владельца 28.09.2026. Владелец поля — Kaiten.
   */
  suggested: readonly string[];
  /** Поля, которые надо отключить и переименовать (данные на карточках остаются). */
  retire: readonly string[];
  /** Пространство-«папка» вокруг пространства разработки; `undefined` — без папки. */
  folder?: string;
  /**
   * Доска проекта из прошлого `setup`: по ней находится пространство, которое
   * ещё называется по-старому, — план переименует его, а не заведёт второе.
   */
  knownBoardId?: number;
  /** Дорожки доски: продукта — по имени репозитория, «Архив». */
  lanes: { repos: Record<string, string>; archive?: string };
  /** Пространства отделов в папке. */
  departments: readonly Department[];
  /** Поля признака «Можно младшему» (`kaiten.junior`); `null` — не заводим. */
  junior: JuniorFields | null;
}

/**
 * Выбор «Можно младшему», строка «Младшему не хватает» и выбор «Оценка»
 * (`npm run assess`) — в типах story, tech, bug, необязательные.
 */
export interface JuniorFields {
  select: { name: string; yes: string; no: string };
  missing: { name: string };
  assess: { name: string; values: Record<AssessVerdict, string> };
  types: readonly TaskType[];
}

export const JUNIOR_FIELDS: JuniorFields = {
  select: { name: 'Можно младшему', yes: 'Да', no: 'Нет' },
  missing: { name: 'Младшему не хватает' },
  assess: { name: 'Оценка', values: { actual: 'Актуальна', done: 'Похоже, сделана', obsolete: 'Похоже, устарела' } },
  types: ['story', 'tech', 'bug'],
};

/** Пространство отдела: доска со своими колонками. type: 1 очередь, 2 в работе, 3 готово. */
export interface Department {
  key: string;
  space: string;
  board: string;
  columns: ReadonlyArray<{ title: string; type: 1 | 2 | 3 }>;
}

/**
 * Шаблоны пространств отделов (решение владельца 07.10): типичный набор
 * фирмы рядом с разработкой. Проект выбирает нужные ключами в
 * `kaiten.departments`. Заведённое пространство отдела план больше не
 * трогает — дальше его настраивают люди.
 */
export const DEPARTMENTS: readonly Department[] = [
  {
    key: 'marketing',
    space: 'Маркетинг',
    board: 'Задачи',
    columns: [
      { title: 'Идеи', type: 1 },
      { title: 'План', type: 1 },
      { title: 'В работе', type: 2 },
      { title: 'Согласование', type: 2 },
      { title: 'Опубликовано', type: 3 },
    ],
  },
  {
    key: 'hr',
    space: 'HR',
    board: 'Найм',
    columns: [
      { title: 'Заявка на вакансию', type: 1 },
      { title: 'Поиск', type: 2 },
      { title: 'Собеседования', type: 2 },
      { title: 'Оффер', type: 2 },
      { title: 'Вышел', type: 3 },
    ],
  },
  {
    key: 'sales',
    space: 'Продажи',
    board: 'Сделки',
    columns: [
      { title: 'Лид', type: 1 },
      { title: 'Квалификация', type: 2 },
      { title: 'КП', type: 2 },
      { title: 'Переговоры', type: 2 },
      { title: 'Сделка', type: 3 },
      { title: 'Отказ', type: 3 },
    ],
  },
  {
    key: 'finance',
    space: 'Финансы',
    board: 'Платежи',
    columns: [
      { title: 'Входящие счета', type: 1 },
      { title: 'Согласование', type: 2 },
      { title: 'К оплате', type: 2 },
      { title: 'Оплачено', type: 3 },
    ],
  },
  {
    key: 'support',
    space: 'Поддержка',
    board: 'Обращения',
    columns: [
      { title: 'Новые', type: 1 },
      { title: 'В работе', type: 2 },
      { title: 'Ждём клиента', type: 2 },
      { title: 'Решено', type: 3 },
    ],
  },
  {
    key: 'admin',
    space: 'Администрирование',
    board: 'Задачи',
    columns: [
      { title: 'Входящие', type: 1 },
      { title: 'В работе', type: 2 },
      { title: 'Готово', type: 3 },
    ],
  },
];

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
  summary: { name: 'Суть' },
  templates: true,
  suggested: ['due_date'],
  retire: [],
  lanes: { repos: {} },
  departments: [],
  junior: null,
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
  folder?: string;
  knownBoardId?: number;
  repoLanes?: Record<string, string>;
  archiveLane?: string;
  departments?: readonly string[];
  junior?: boolean;
}): DesiredStructure {
  const unknown = (input.departments ?? []).filter((key) => !DEPARTMENTS.some((d) => d.key === key));
  if (unknown.length > 0) throw new Error(`Нет шаблона отдела: ${unknown.join(', ')} (есть: ${DEPARTMENTS.map((d) => d.key).join(', ')})`);
  if ((input.departments ?? []).length > 0 && !input.folder) throw new Error('Пространства отделов кладутся в папку — задайте kaiten.folder');
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
    ...(input.folder ? { folder: input.folder } : {}),
    ...(input.knownBoardId !== undefined ? { knownBoardId: input.knownBoardId } : {}),
    lanes: { repos: input.repoLanes ?? {}, ...(input.archiveLane ? { archive: input.archiveLane } : {}) },
    departments: DEPARTMENTS.filter((d) => (input.departments ?? []).includes(d.key)),
    junior: input.junior ? JUNIOR_FIELDS : null,
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
  | { kind: 'create-folder'; title: string }
  /** Пространство разработки: переименовать и/или положить в папку. */
  | { kind: 'move-space'; id: number; from: string; title: string; folder?: string }
  | { kind: 'create-space'; title: string }
  | { kind: 'create-lane'; title: string; sortOrder: number }
  | { kind: 'create-department'; space: string; board: string; columns: Array<{ title: string; type: 1 | 2 | 3 }> }
  | { kind: 'create-board'; title: string; columns: Array<{ title: string; type: 1 | 2 | 3 }> }
  | { kind: 'create-column'; title: string; type: 1 | 2 | 3; sortOrder: number }
  | { kind: 'create-card-type'; name: string; letter: string; color: number }
  | { kind: 'retire-property'; id: number; name: string; newName: string }
  | { kind: 'create-property'; name: string; type: 'select' | 'string' }
  | { kind: 'set-type-template'; typeName: string; template: string }
  | { kind: 'require-type-property'; typeName: string; property: string }
  | { kind: 'suggest-type-field'; typeName: string; field: string }
  /** Поле в типе, необязательное, — в конец списка полей типа. */
  | { kind: 'add-type-property'; typeName: string; property: string; propertyType: 'select' | 'string' }
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

/**
 * Пространство разработки: сначала по доске проекта из прошлого `setup`, потом
 * по имени — только в своей папке или на верхнем уровне. Имя одно на разные
 * проекты («Разработка» в каждой папке): по имени во всём аккаунте `setup`
 * нашёл бы пространство чужого проекта и перенёс бы его к себе.
 */
export function findSpace(current: CurrentStructure, desired: DesiredStructure): Space | undefined {
  const spaces = current.spaces.filter(alive);
  const byBoard = desired.knownBoardId === undefined ? undefined : spaces.find((s) => (s.boards ?? []).some((b) => b.id === desired.knownBoardId));
  if (byBoard) return byBoard;
  const named = spaces.filter((s) => same(s.title, desired.space));
  // Без папки — верхний уровень; вложенное — только если оно с таким именем одно
  // (родитель может быть токену не виден).
  if (!desired.folder) return named.find((s) => !s.parent_entity_uid) ?? (named.length === 1 ? named[0] : undefined);
  const folders = new Set(spaces.filter((s) => !s.parent_entity_uid && same(s.title, desired.folder ?? '')).map((s) => s.uid));
  return (
    named.find((s) => s.parent_entity_uid && folders.has(s.parent_entity_uid)) ??
    // Ещё не перенесено в папку: наверху, и это не сама папка.
    named.find((s) => !s.parent_entity_uid && !same(s.title, desired.folder ?? ''))
  );
}

/** Папка: пространство с этим именем на верхнем уровне — не само пространство разработки. */
export function findFolder(current: CurrentStructure, desired: DesiredStructure): Space | undefined {
  if (!desired.folder) return undefined;
  const dev = findSpace(current, desired);
  return current.spaces.filter(alive).find((s) => same(s.title, desired.folder ?? '') && !s.parent_entity_uid && s.id !== dev?.id);
}

/** Пространство отдела — внутри папки. */
export function findDepartment(current: CurrentStructure, folder: Space | undefined, department: Department): Space | undefined {
  if (!folder?.uid) return undefined;
  return current.spaces.filter(alive).find((s) => same(s.title, department.space) && s.parent_entity_uid === folder.uid);
}

const laneTitle = (lane: { title?: string | null }): string => lane.title ?? '';

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
function findClash(current: CurrentStructure, name: string, type: string = 'select'): CustomProperty | undefined {
  return current.properties.filter(alive).find((p) => same(p.name, name) && p.type !== type);
}

/** Действующее текстовое поле с таким именем. */
export function findText(current: CurrentStructure, name: string): CustomProperty | undefined {
  return current.properties.filter(alive).find((p) => same(p.name, name) && p.type === 'string');
}

/** Стандартное поле (`due_date`, `tags`…) уже есть в полях типа. */
export function typeSuggests(type: CardType, field: string): boolean {
  return (type.card_properties ?? []).some((p) => p.regular_property === field);
}

/** Поле есть в типе (обязательное или нет). */
export function typeHas(type: CardType, property: CustomProperty | undefined): boolean {
  if (!property?.uid) return false;
  return (type.card_properties ?? []).some((p) => p.property_uid === property.uid);
}

/** Поле обязательно в типе: есть в `card_properties` с `required: true`. */
export function typeRequires(type: CardType, property: CustomProperty | undefined): boolean {
  if (!property?.uid) return false;
  return (type.card_properties ?? []).some((p) => p.property_uid === property.uid && p.required === true);
}

function aliveValues(current: CurrentStructure, propertyId: number): SelectValue[] {
  return (current.selectValues[propertyId] ?? []).filter(alive);
}

export function planSetup(current: CurrentStructure, desired: DesiredStructure = DESIRED): SetupPlan {
  const actions: SetupAction[] = [];
  const reused: string[] = [];
  const extra: string[] = [];

  const space = findSpace(current, desired);
  // Папку, которую токен не видит, план не найдёт и завёл бы вторую с тем же
  // именем, вынеся в неё пространство из настоящей.
  if (desired.folder && space?.parent_entity_uid && !current.spaces.some((s) => s.uid === space.parent_entity_uid)) {
    throw new Error(
      `Пространство «${space.title}» лежит в папке, к которой у пользователя токена нет доступа: setup завёл бы вторую папку «${desired.folder}». ` +
        'Дайте ему доступ к папке пространства и повторите.',
    );
  }

  const folder = findFolder(current, desired);
  if (desired.folder) {
    if (!folder) actions.push({ kind: 'create-folder', title: desired.folder });
    else reused.push(`папка «${folder.title}» (${folder.id})`);
  }

  if (!space) actions.push({ kind: 'create-space', title: desired.space });
  else {
    const rename = !same(space.title, desired.space);
    const move = desired.folder !== undefined && (!folder?.uid || space.parent_entity_uid !== folder.uid);
    if (rename || move) actions.push({ kind: 'move-space', id: space.id, from: space.title, title: desired.space, ...(desired.folder ? { folder: desired.folder } : {}) });
    else reused.push(`пространство «${space.title}» (${space.id})`);
  }

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
  // Дорожки продуктов и «Архив» — по имени; новая доска приходит с одной дорожкой по умолчанию.
  const lanes = board?.lanes ?? [];
  let nextLane = Math.max(0, ...lanes.map((l) => l.sort_order ?? 0));
  for (const title of wantedLanes(desired)) {
    const found = lanes.find((l) => same(laneTitle(l), title));
    if (found) reused.push(`дорожка «${title}» (${found.id})`);
    else actions.push({ kind: 'create-lane', title, sortOrder: ++nextLane });
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
  const wantedNames = [
    ...SELECT_ROLES.map((r) => desired.selects[r].name),
    ...(desired.junior ? [desired.junior.select.name, desired.junior.missing.name, desired.junior.assess.name] : []),
  ];
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

  // «Суть»: текстовое поле, обязательное во всех типах схемы.
  const summary = desired.summary ? findText(current, desired.summary.name) : undefined;
  if (desired.summary) {
    const clash = findClash(current, desired.summary.name, 'string');
    if (clash) actions.push({ kind: 'retire-property', id: clash.id, name: clash.name, newName: `${clash.name} (${clash.type ?? 'другой тип'}, отключено)` });
    if (!summary) actions.push({ kind: 'create-property', name: desired.summary.name, type: 'string' });
    else reused.push(`поле «${summary.name}» (${summary.id})`);
  }
  for (const type of desired.types) {
    const found = findCardType(current, type.name);
    const template = kaitenTemplate(type.key);
    if (desired.templates && (found?.description_template ?? null) !== template) {
      actions.push({ kind: 'set-type-template', typeName: type.name, template });
    }
    if (desired.summary && !(found && typeRequires(found, summary))) {
      actions.push({ kind: 'require-type-property', typeName: type.name, property: desired.summary.name });
    }
    for (const field of desired.suggested) {
      if (!(found && typeSuggests(found, field))) actions.push({ kind: 'suggest-type-field', typeName: type.name, field });
    }
  }

  if (desired.junior) planJunior(current, desired.junior, desired.types, actions, reused);

  for (const department of desired.departments) {
    const found = findDepartment(current, folder, department);
    if (found) reused.push(`пространство отдела «${found.title}» (${found.id})`);
    else actions.push({ kind: 'create-department', space: department.space, board: department.board, columns: department.columns.map((c) => ({ ...c })) });
  }

  return { actions, reused, extra };
}

/** Поля «Можно младшему», «Младшему не хватает» и «Оценка»: завести, варианты, добавить в типы. */
function planJunior(current: CurrentStructure, junior: JuniorFields, types: DesiredStructure['types'], actions: SetupAction[], reused: string[]): void {
  const fields = [
    { name: junior.select.name, type: 'select' as const, found: findSelect(current, junior.select.name), values: [junior.select.yes, junior.select.no] },
    { name: junior.missing.name, type: 'string' as const, found: findText(current, junior.missing.name), values: [] },
    { name: junior.assess.name, type: 'select' as const, found: findSelect(current, junior.assess.name), values: Object.values(junior.assess.values) },
  ];
  for (const field of fields) {
    const clash = findClash(current, field.name, field.type);
    if (clash) actions.push({ kind: 'retire-property', id: clash.id, name: clash.name, newName: `${clash.name} (${clash.type ?? 'другой тип'}, отключено)` });
    if (!field.found) actions.push({ kind: 'create-property', name: field.name, type: field.type });
    else reused.push(`поле «${field.found.name}» (${field.found.id})`);
  }
  for (const field of fields) {
    const have = field.found ? aliveValues(current, field.found.id) : [];
    for (const value of field.values) {
      if (!have.some((v) => same(v.value, value))) actions.push({ kind: 'create-select-value', property: field.name, value });
    }
  }
  for (const type of types.filter((t) => junior.types.includes(t.key))) {
    const found = findCardType(current, type.name);
    for (const field of fields) {
      if (!(found && typeHas(found, field.found))) actions.push({ kind: 'add-type-property', typeName: type.name, property: field.name, propertyType: field.type });
    }
  }
}

/** Дорожки доски по схеме: продуктов (без повторов) и «Архив». */
export function wantedLanes(desired: DesiredStructure): string[] {
  const titles = [...Object.values(desired.lanes.repos), ...(desired.lanes.archive ? [desired.lanes.archive] : [])];
  return titles.filter((t, i) => titles.findIndex((o) => same(o, t)) === i);
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
  repoLanes?: Record<string, number>;
  archiveLaneId?: number;
  columns: Record<string, number>;
  types: Record<string, number>;
  priorityProperty: SelectMapping;
  repoProperty?: SelectMapping;
  teamProperty?: SelectMapping;
  /** Текстовое поле «Суть». */
  summaryProperty?: { id: number };
  /** «Можно младшему»: варианты `yes`/`no`. */
  juniorProperty?: SelectMapping;
  juniorMissingProperty?: { id: number };
  /** «Оценка»: варианты `actual`/`done`/`obsolete`. */
  assessProperty?: SelectMapping;
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

  const summaryProperty = desired.summary ? findText(current, desired.summary.name) : undefined;
  if (desired.summary && !summaryProperty) missing.push(`поле «${desired.summary.name}»`);

  let junior: Pick<KaitenMapping, 'juniorProperty' | 'juniorMissingProperty' | 'assessProperty'> = {};
  if (desired.junior) {
    const spec = desired.junior;
    /** Выбор с вариантами по ключу; чего нет — в `missing`. */
    const selectMapping = (name: string, wanted: Record<string, string>): SelectMapping | undefined => {
      const select = findSelect(current, name);
      if (!select) {
        missing.push(`поле-выбор «${name}»`);
        return undefined;
      }
      const values: Record<string, number> = {};
      for (const [key, value] of Object.entries(wanted)) {
        const found = aliveValues(current, select.id).find((v) => same(v.value, value));
        if (found) values[key] = found.id;
        else missing.push(`вариант «${value}» поля «${name}»`);
      }
      return Object.keys(values).length === Object.keys(wanted).length ? { id: select.id, values } : undefined;
    };
    const juniorProperty = selectMapping(spec.select.name, { yes: spec.select.yes, no: spec.select.no });
    const missingField = findText(current, spec.missing.name);
    if (!missingField) missing.push(`поле «${spec.missing.name}»`);
    const assessProperty = selectMapping(spec.assess.name, spec.assess.values);
    if (juniorProperty && missingField && assessProperty) {
      junior = { juniorProperty, juniorMissingProperty: { id: missingField.id }, assessProperty };
    }
  }

  const laneOf = (title: string): number | undefined => {
    const found = board?.lanes.find((l) => same(laneTitle(l), title));
    if (!found) missing.push(`дорожка «${title}»`);
    return found?.id;
  };
  const repoLanes: Record<string, number> = {};
  for (const [repo, title] of Object.entries(desired.lanes.repos)) {
    const id = laneOf(title);
    if (id !== undefined) repoLanes[repo] = id;
  }
  const archiveLaneId = desired.lanes.archive ? laneOf(desired.lanes.archive) : undefined;

  if (missing.length > 0 || !board || !selects.priority) {
    throw new Error(`В аккаунте не хватает: ${missing.join(', ') || 'поля приоритета'}`);
  }

  // Дорожка по умолчанию — первая, которая не продукта и не «Архив»: в неё эпики и задачи без своей дорожки.
  // Дорожки в схеме не заданы, а на доске их несколько — выбирать владельцу, не угадываем.
  const special = new Set([...Object.values(repoLanes), ...(archiveLaneId === undefined ? [] : [archiveLaneId])]);
  const laneId =
    special.size === 0 && board.lanes.length > 1
      ? undefined
      : [...board.lanes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).find((l) => !special.has(l.id))?.id;

  return {
    boardId: board.id,
    ...(laneId === undefined ? {} : { laneId }),
    ...(Object.keys(repoLanes).length > 0 ? { repoLanes } : {}),
    ...(archiveLaneId === undefined ? {} : { archiveLaneId }),
    columns,
    types,
    priorityProperty: selects.priority,
    ...(selects.repo ? { repoProperty: selects.repo } : {}),
    ...(selects.team ? { teamProperty: selects.team } : {}),
    ...(summaryProperty ? { summaryProperty: { id: summaryProperty.id } } : {}),
    ...junior,
  };
}
