/**
 * Kaiten глазами агента: клиент с нужными серверу вызовами, контекст доски
 * (колонки, типы, поля, ограничения, правила из описания) и перевод полей
 * между «как говорит человек» (имя поля, текст варианта) и «как хранит
 * Kaiten» (`id_<поле>`, id варианта).
 */

import { z } from 'zod';

import { type Card, type CardType, CardTypeSchema, type CustomProperty, KaitenClient, type SelectValue } from '../kaiten-client.js';
import { type BoardRules, coverageProblems, normalizeTitle, type ParsedDescription, parseBoardDescription, typeRule } from './board-rules.js';
import { applicable, demandedProperties, parseRestrictions, type Restriction } from './restrictions.js';

const BoardFullSchema = z
  .object({
    id: z.number(),
    title: z.string().default(''),
    description: z.string().nullable().optional(),
    default_card_type_id: z.number().nullable().optional(),
    columns: z.array(z.object({ id: z.number(), title: z.string().default(''), type: z.number().default(2), sort_order: z.number().default(0) }).passthrough()).default([]),
    lanes: z.array(z.object({ id: z.number(), title: z.string().nullable().optional(), sort_order: z.number().default(0) }).passthrough()).default([]),
  })
  .passthrough();
export type BoardFull = z.infer<typeof BoardFullSchema>;

/** Клиент Kaiten с вызовами агентского сервера (всё равно проходит через заслонку). */
export class AgentKaiten extends KaitenClient {
  async getBoard(boardId: number): Promise<BoardFull> {
    return this.request('GET', `/boards/${boardId}`, { schema: BoardFullSchema });
  }

  async addTag(cardId: number, name: string): Promise<unknown> {
    return this.request('POST', `/cards/${cardId}/tags`, { body: { name }, schema: z.unknown() });
  }

  async addMember(cardId: number, userId: number): Promise<unknown> {
    return this.request('POST', `/cards/${cardId}/members`, { body: { user_id: userId }, schema: z.unknown() });
  }

  /** Тип участника 2 — ответственный. */
  async makeResponsible(cardId: number, userId: number): Promise<unknown> {
    return this.request('PATCH', `/cards/${cardId}/members/${userId}`, { body: { type: 2 }, schema: z.unknown() });
  }

  async addBlocker(cardId: number, reason: string): Promise<unknown> {
    return this.request('POST', `/cards/${cardId}/blockers`, { body: { reason }, schema: z.unknown() });
  }

  async addExternalLink(cardId: number, url: string, description: string): Promise<unknown> {
    return this.request('POST', `/cards/${cardId}/external-links`, { body: { url, description }, schema: z.unknown() });
  }

  async createChecklistNamed(cardId: number, name: string): Promise<{ id: number }> {
    return this.request('POST', `/cards/${cardId}/checklists`, { body: { name }, schema: z.object({ id: z.number() }).passthrough() });
  }

  // ── документы (docs/kaiten-api.md, «Документы») ──

  async getDocument(uid: string): Promise<KaitenDocument> {
    return this.request('GET', `/documents/${encodeURIComponent(uid)}`, { schema: DocumentSchema });
  }

  /** Содержимое — только целиком; `POST` его молча выбрасывает, поэтому текст — отдельным `PATCH`. */
  async updateDocument(uid: string, patch: { data?: unknown; title?: string }): Promise<unknown> {
    return this.request('PATCH', `/documents/${encodeURIComponent(uid)}`, { body: patch, schema: z.unknown() });
  }

  async createDocument(body: { title: string; parent_entity_uid: string; sort_order: number }): Promise<KaitenDocument> {
    return this.request('POST', '/documents', { body, schema: DocumentSchema });
  }

  /** Дети узла дерева (пространства, папки, документа). */
  async treeChildren(parentUid: string): Promise<TreeNode[]> {
    return this.request('GET', '/tree-entities', { query: { parent_entity_uid: parentUid, levels_count: 1 }, schema: z.array(TreeNodeSchema) });
  }

  async getDocumentGroup(uid: string): Promise<TreeNode> {
    return this.request('GET', `/document-groups/${encodeURIComponent(uid)}`, { schema: TreeNodeSchema });
  }

  /** Поиск документов по заголовку. */
  async searchDocuments(query: string): Promise<KaitenDocument[]> {
    return this.request('GET', '/documents', { query: { query }, schema: z.array(DocumentSchema) });
  }
}

const DocumentSchema = z
  .object({
    uid: z.string(),
    title: z.string().default(''),
    parent_entity_uid: z.string().nullable().optional(),
    updated: z.string().optional(),
    data: z.unknown().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();
export type KaitenDocument = z.infer<typeof DocumentSchema>;

const TreeNodeSchema = z
  .object({
    uid: z.string(),
    title: z.string().default(''),
    entity_type: z.string().default(''),
    parent_entity_uid: z.string().nullable().optional(),
    has_children: z.boolean().optional(),
    sort_order: z.number().optional(),
  })
  .passthrough();
export type TreeNode = z.infer<typeof TreeNodeSchema>;

// ── поля ─────────────────────────────────────────────────────────────────────

export interface FieldInfo {
  id: number;
  key: string;
  name: string;
  type: string;
  values?: SelectValue[];
}

const norm = (text: string): string => normalizeTitle(text);

/** Значение поля в виде, понятном человеку. */
export function displayValue(field: FieldInfo, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value) && field.values) {
    return value.map((id) => field.values?.find((v) => v.id === id)?.value ?? String(id)).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Перевести значение от агента в формат Kaiten; строка — что не так. */
export function toKaitenValue(field: FieldInfo, input: unknown): { value: unknown } | { problem: string } {
  const allowed = field.values?.filter((v) => v.condition !== 'inactive' && v.condition !== 'deleted').map((v) => v.value);
  switch (field.type) {
    case 'select':
    case 'multi_select': {
      const items = Array.isArray(input) ? input : [input];
      if (field.type === 'select' && items.length !== 1) return { problem: `«${field.name}»: один вариант из: ${allowed?.join(', ')}` };
      const ids: number[] = [];
      for (const item of items) {
        const found = typeof item === 'string' ? field.values?.find((v) => norm(v.value) === norm(item) && v.condition !== 'inactive') : undefined;
        if (!found) return { problem: `«${field.name}»: «${String(item)}» — нет такого варианта; допустимо: ${allowed?.join(', ')}` };
        ids.push(found.id);
      }
      return { value: ids };
    }
    case 'number': {
      const n = typeof input === 'number' ? input : typeof input === 'string' && input.trim() !== '' ? Number(input.replace(',', '.')) : NaN;
      return Number.isFinite(n) ? { value: n } : { problem: `«${field.name}»: нужно число` };
    }
    case 'string':
      return typeof input === 'string' && input.trim() !== '' ? { value: input.trim() } : { problem: `«${field.name}»: нужен непустой текст` };
    default:
      return { problem: `«${field.name}»: поле типа «${field.type}» агент пока не заполняет — заполните в Kaiten` };
  }
}

// ── контекст доски ───────────────────────────────────────────────────────────

export interface BoardContext {
  board: BoardFull;
  spaceId: number;
  types: CardType[];
  fields: Map<string, FieldInfo>;
  restrictions: Restriction[];
  parsed: ParsedDescription | null;
  /** Почему доска закрыта для записи; пусто — открыта. */
  closed: string[];
}

const fieldKey = (id: number): string => `id_${id}`;

/** Загрузчик с кэшем на один запрос MCP: справочники компании читаются один раз. */
export class Catalog {
  private types?: Promise<CardType[]>;
  private properties?: Promise<CustomProperty[]>;
  private spaces?: Promise<Map<number, number>>;
  private values = new Map<number, Promise<SelectValue[]>>();
  private restrictionsBySpace = new Map<number, Promise<Restriction[]>>();

  constructor(readonly kaiten: AgentKaiten) {}

  cardTypes(): Promise<CardType[]> {
    this.types ??= this.kaiten.listCardTypes().then((list) => list.map((t) => CardTypeSchema.parse(t)));
    return this.types;
  }

  customProperties(): Promise<CustomProperty[]> {
    this.properties ??= this.kaiten.listCustomProperties();
    return this.properties;
  }

  /** id доски → id пространства. */
  async spaceOf(boardId: number): Promise<number | null> {
    this.spaces ??= this.kaiten.listSpaces().then((list) => {
      const map = new Map<number, number>();
      for (const space of list) for (const board of space.boards ?? []) map.set(board.id, space.id);
      return map;
    });
    return (await this.spaces).get(boardId) ?? null;
  }

  async field(propertyId: number): Promise<FieldInfo | null> {
    const property = (await this.customProperties()).find((p) => p.id === propertyId);
    if (!property) return null;
    const info: FieldInfo = { id: property.id, key: fieldKey(property.id), name: property.name, type: property.type ?? 'string' };
    if (info.type === 'select' || info.type === 'multi_select') {
      if (!this.values.has(property.id)) this.values.set(property.id, this.kaiten.listSelectValues(property.id));
      info.values = await this.values.get(property.id);
    }
    return info;
  }

  async fieldByUid(uid: string): Promise<FieldInfo | null> {
    const property = (await this.customProperties()).find((p) => p.uid === uid);
    return property ? this.field(property.id) : null;
  }

  async restrictions(spaceId: number): Promise<Restriction[]> {
    if (!this.restrictionsBySpace.has(spaceId)) {
      this.restrictionsBySpace.set(spaceId, this.kaiten.listRestrictions(spaceId).then(parseRestrictions));
    }
    return this.restrictionsBySpace.get(spaceId) as Promise<Restriction[]>;
  }

  /** Поля типа карточки: все, что предлагает тип, и отдельно — обязательные. */
  async typeFields(type: CardType): Promise<{ all: FieldInfo[]; required: FieldInfo[] }> {
    const all: FieldInfo[] = [];
    const required: FieldInfo[] = [];
    for (const p of type.card_properties ?? []) {
      if (!p.property_uid) continue;
      const info = await this.fieldByUid(p.property_uid);
      if (!info) continue;
      all.push(info);
      if (p.required) required.push(info);
    }
    return { all, required };
  }

  async boardContext(boardId: number): Promise<BoardContext> {
    const board = await this.kaiten.getBoard(boardId);
    board.columns.sort((a, b) => a.sort_order - b.sort_order);
    board.lanes.sort((a, b) => a.sort_order - b.sort_order);
    const spaceId = await this.spaceOf(boardId);
    if (spaceId === null) throw new Error('Доска не найдена среди доступных пространств');
    const types = await this.cardTypes();
    const restrictions = await this.restrictions(spaceId);
    const parsedResult = parseBoardDescription(board.description);
    const fields = new Map<string, FieldInfo>();
    const ctx: BoardContext = { board, spaceId, types, fields, restrictions, parsed: null, closed: [] };
    if (!parsedResult.ok) {
      ctx.closed = parsedResult.problems;
      return ctx;
    }
    ctx.parsed = parsedResult.value;

    // Поля, которые обязаны быть описаны: обязательные в разрешённых типах и
    // требуемые ограничениями этой доски (создание и перенос в любую колонку).
    const mustDescribe = new Set<string>();
    for (const type of allowedTypes(ctx)) {
      const { all, required } = await this.typeFields(type);
      for (const f of all) fields.set(f.key, f);
      for (const f of required) mustDescribe.add(f.name);
    }
    const onBoard = [
      ...applicable(restrictions, 'creation', { boardId }),
      ...board.columns.flatMap((c) => applicable(restrictions, 'movement', { boardId, columnId: c.id })),
    ];
    for (const r of onBoard) {
      for (const key of demandedProperties(r)) {
        const info = await this.field(Number(key.replace('id_', '')));
        if (!info) continue;
        fields.set(info.key, info);
        mustDescribe.add(info.name);
      }
    }
    ctx.closed = [
      ...coverageProblems(ctx.parsed, board.columns.map((c) => c.title), [...mustDescribe]),
      ...ruleProblems(ctx),
    ];
    return ctx;
  }
}

/** Типы, которые правила разрешают заводить на доске. */
export function allowedTypes(ctx: BoardContext): CardType[] {
  const rules = ctx.parsed?.rules;
  if (!rules) return [];
  if (rules.types['*']) {
    const fallback = ctx.types.find((t) => t.id === ctx.board.default_card_type_id);
    const named = Object.keys(rules.types).filter((n) => n !== '*').map((n) => ctx.types.find((t) => t.name === n)).filter((t): t is CardType => !!t);
    return fallback ? [fallback, ...named.filter((t) => t.id !== fallback.id)] : named;
  }
  return Object.keys(rules.types).map((name) => ctx.types.find((t) => t.name === name)).filter((t): t is CardType => !!t);
}

/** Колонки, куда агент может заводить карточки: очереди (тип 1), суженные правилами. */
export function creationColumns(ctx: BoardContext): BoardFull['columns'] {
  const queue = ctx.board.columns.filter((c) => c.type === 1);
  const only = ctx.parsed?.rules.columns;
  return only ? queue.filter((c) => only.includes(c.title)) : queue;
}

/** Дорожка по умолчанию — первая по порядку. */
export function defaultLane(ctx: BoardContext): BoardFull['lanes'][number] | undefined {
  return ctx.board.lanes[0];
}

export const laneTitle = (lane: BoardFull['lanes'][number]): string => (lane.title && lane.title.trim() ? lane.title : 'по умолчанию');

/** Ошибки самих правил против устройства доски (опечатки в именах). */
function ruleProblems(ctx: BoardContext): string[] {
  const rules = ctx.parsed?.rules as BoardRules;
  const problems: string[] = [];
  for (const name of rules.columns ?? []) {
    const column = ctx.board.columns.find((c) => c.title === name);
    if (!column) problems.push(`в правилах колонка «${name}», которой нет на доске`);
    else if (column.type !== 1) problems.push(`в правилах колонка «${name}» — не очередь: создавать можно только в очередях`);
  }
  if (creationColumns(ctx).length === 0) problems.push('на доске нет колонки-очереди для новых карточек');
  for (const [name, rule] of Object.entries(rules.types)) {
    if (name !== '*' && !ctx.types.some((t) => t.name === name)) problems.push(`в правилах тип «${name}», которого нет в Kaiten`);
    if (rule.lane !== 'choose' && rule.lane !== 'default' && !ctx.board.lanes.some((l) => l.title === rule.lane)) {
      problems.push(`в правилах типа «${name}» дорожка «${rule.lane}», которой нет на доске`);
    }
    if (rule.parent !== 'none' && !ctx.types.some((t) => t.name === rule.parent)) problems.push(`в правилах родитель «${rule.parent}» — нет такого типа`);
  }
  return problems;
}

export function typeRuleFor(ctx: BoardContext, type: CardType): ReturnType<typeof typeRule> {
  return ctx.parsed ? typeRule(ctx.parsed.rules, type.name) : null;
}

/** Колонка «готово» — карточка закрыта и в дублях не участвует. */
export function isOpen(ctx: BoardContext, card: Card): boolean {
  const column = ctx.board.columns.find((c) => c.id === card.column_id);
  return !card.archived && column?.type !== 3;
}
