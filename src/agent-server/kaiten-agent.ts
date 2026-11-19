/**
 * Kaiten глазами агента: клиент с нужными серверу вызовами, контекст доски
 * (колонки, типы, поля, ограничения, правила из описания) и перевод полей
 * между «как говорит человек» (имя поля, текст варианта) и «как хранит
 * Kaiten» (`id_<поле>`, id варианта).
 */

import { z } from 'zod';

import { type Card, type CardType, CardTypeSchema, type CustomProperty, DocumentSchema, KaitenApiError, KaitenClient, type KaitenDocument, mimeOf, type SelectValue, type Space, type SpaceUser } from '../kaiten-client.js';
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

  // ── документы (docs/kaiten-api.md, «Документы»): чтение и запись — в общем клиенте ──

  async createDocument(body: { title: string; parent_entity_uid: string; sort_order: number }): Promise<KaitenDocument> {
    return this.request('POST', '/documents', { body, schema: DocumentSchema });
  }

  /**
   * Файл в документ: `POST /documents/{uid}/files`, поле `file` (живьём 10.11.2026).
   * `url` ответа — постоянный адрес вида `https://files/…`: его и кладут в `src` картинки.
   */
  async uploadDocumentFile(docUid: string, name: string, content: Uint8Array): Promise<DocumentFile> {
    if (!DOC_UUID.test(docUid)) throw new KaitenApiError(`файлы документа — только по UUID, а не «${docUid}»`, 0, '');
    const form = new FormData();
    const type = mimeOf(name);
    form.append('file', new Blob([new Uint8Array(content)], type ? { type } : {}), name);
    return this.request('POST', `/documents/${docUid}/files`, { form, schema: DocumentFileSchema });
  }

  /** Дети узла дерева (пространства, папки, документа). */
  async treeChildren(parentUid: string): Promise<TreeNode[]> {
    return this.listAll('/tree-entities', TreeNodeSchema, { parent_entity_uid: parentUid, levels_count: 1 });
  }

  async getDocumentGroup(uid: string): Promise<TreeNode> {
    return this.request('GET', `/document-groups/${encodeURIComponent(uid)}`, { schema: TreeNodeSchema });
  }

  /** Поиск документов по заголовку. */
  async searchDocuments(query: string): Promise<KaitenDocument[]> {
    return this.listAll('/documents', DocumentSchema, { query });
  }
}

export type { KaitenDocument };

const DOC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DocumentFileSchema = z.object({ id: z.string(), url: z.string() }).passthrough();
export type DocumentFile = z.infer<typeof DocumentFileSchema>;

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
  /** Что не так с описанием, но запись не мешает: агенту — подсказка. */
  warnings: string[];
  /** Типы, разрешённые пространству; пусто — ограничения нет. */
  spaceTypeIds: number[];
}

const fieldKey = (id: number): string => `id_${id}`;

/** Загрузчик с кэшем на один запрос MCP: справочники компании читаются один раз. */
export class Catalog {
  private types?: Promise<CardType[]>;
  private properties?: Promise<CustomProperty[]>;
  private spaceList?: Promise<Space[]>;
  private spaces?: Promise<Map<number, Space>>;
  private peopleBySpace = new Map<number, Promise<SpaceUser[]>>();
  private groupAccess?: Promise<Array<{ uid: string; entities: Set<string> }>>;
  private groupUsers = new Map<string, Promise<SpaceUser[]>>();
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

  allSpaces(): Promise<Space[]> {
    this.spaceList ??= this.kaiten.listSpaces();
    return this.spaceList;
  }

  /** Пространство, в котором лежит доска. */
  async spaceOf(boardId: number): Promise<Space | null> {
    this.spaces ??= this.allSpaces().then((list) => {
      const map = new Map<number, Space>();
      for (const space of list) for (const board of space.boards ?? []) map.set(board.id, space);
      return map;
    });
    return (await this.spaces).get(boardId) ?? null;
  }

  /**
   * Люди с доступом к пространству: его участники, участники пространств выше
   * и участники групп с доступом к любому из них. Kaiten наследует доступ от
   * родителя, а в списке дочернего пространства унаследованных нет (живьём
   * 16.10: у многих — пусто); доступ через группу в этом списке тоже не виден
   * (живьём 19.10). Родитель может быть токену не виден — его `uid` всё равно
   * сверяется с доступами групп. Отключённые и виртуальные — не адресаты.
   */
  people(spaceId: number): Promise<SpaceUser[]> {
    if (!this.peopleBySpace.has(spaceId)) {
      this.peopleBySpace.set(
        spaceId,
        (async () => {
          const spaces = await this.allSpaces();
          const byUid = new Map(spaces.map((s) => [s.uid, s]));
          const out = new Map<number, SpaceUser>();
          const add = (users: SpaceUser[]): void => {
            for (const user of users) if (user.activated !== false && !user.virtual && !out.has(user.id)) out.set(user.id, user);
          };
          const chain = new Set<string>();
          const seen = new Set<number>();
          for (let cur = spaces.find((s) => s.id === spaceId); cur && !seen.has(cur.id); cur = cur.parent_entity_uid ? byUid.get(cur.parent_entity_uid) : undefined) {
            seen.add(cur.id);
            if (cur.uid) chain.add(cur.uid);
            if (cur.parent_entity_uid) chain.add(cur.parent_entity_uid);
            add(await this.kaiten.listSpaceUsers(cur.id));
          }
          for (const group of await this.groups()) if ([...chain].some((uid) => group.entities.has(uid))) add(await this.usersOfGroup(group.uid));
          return [...out.values()];
        })(),
      );
    }
    return this.peopleBySpace.get(spaceId) as Promise<SpaceUser[]>;
  }

  /** Группы и их доступы; группы не читаются (нет прав) — только личные доступы. */
  private groups(): Promise<Array<{ uid: string; entities: Set<string> }>> {
    this.groupAccess ??= (async () => {
      try {
        const groups = await this.kaiten.listGroups();
        return await Promise.all(groups.map(async (g) => ({ uid: g.uid, entities: new Set((await this.kaiten.listGroupEntities(g.uid)).map((e) => e.uid)) })));
      } catch (error) {
        if (error instanceof KaitenApiError && (error.status === 403 || error.status === 404)) return [];
        throw error;
      }
    })();
    return this.groupAccess;
  }

  private usersOfGroup(uid: string): Promise<SpaceUser[]> {
    if (!this.groupUsers.has(uid)) this.groupUsers.set(uid, this.kaiten.listGroupUsers(uid));
    return this.groupUsers.get(uid) as Promise<SpaceUser[]>;
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
    const space = await this.spaceOf(boardId);
    if (space === null) throw new Error('Доска не найдена среди доступных пространств');
    const spaceId = space.id;
    const types = await this.cardTypes();
    const restrictions = await this.restrictions(spaceId);
    const parsedResult = parseBoardDescription(board.description);
    const fields = new Map<string, FieldInfo>();
    const spaceTypeIds = space.allowed_card_type_ids ?? [];
    const ctx: BoardContext = { board, spaceId, types, fields, restrictions, parsed: null, closed: [], warnings: [], spaceTypeIds };
    if (!parsedResult.ok) {
      ctx.closed = parsedResult.problems;
      return ctx;
    }
    ctx.parsed = parsedResult.value;
    ctx.warnings = [...parsedResult.value.warnings];
    if (ctx.parsed.rules.access === 'read') ctx.closed.push('владелец доски оставил агенту только чтение (access: read в правилах)');

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
    ctx.warnings.push(...coverageProblems(ctx.parsed, board.columns.map((c) => c.title), [...mustDescribe]));
    ctx.closed.push(...ruleProblems(ctx));
    return ctx;
  }
}

/**
 * Типы доски для `"*"`: у доски в Kaiten своего набора типов нет — это типы,
 * разрешённые пространству, а если ограничения нет — тип доски по умолчанию.
 */
export function boardTypes(ctx: BoardContext): CardType[] {
  const fallback = ctx.types.find((t) => t.id === ctx.board.default_card_type_id);
  const allowed = ctx.spaceTypeIds.length > 0 ? ctx.types.filter((t) => ctx.spaceTypeIds.includes(t.id) && !t.archived) : [];
  if (allowed.length === 0) return fallback ? [fallback] : [];
  return fallback && allowed.some((t) => t.id === fallback.id) ? [fallback, ...allowed.filter((t) => t.id !== fallback.id)] : allowed;
}

/** Типы, которые правила разрешают заводить на доске. */
export function allowedTypes(ctx: BoardContext): CardType[] {
  const rules = ctx.parsed?.rules;
  if (!rules) return [];
  const named = Object.keys(rules.types).filter((n) => n !== '*').map((n) => ctx.types.find((t) => t.name === n)).filter((t): t is CardType => !!t);
  if (!rules.types['*']) return named;
  const base = boardTypes(ctx);
  return [...base, ...named.filter((t) => !base.some((b) => b.id === t.id))];
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
  if (allowedTypes(ctx).length === 0) problems.push('непонятно, какой тип карточки заводить: у доски нет типа по умолчанию — задайте его в Kaiten или перечислите типы в блоке правил');
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
