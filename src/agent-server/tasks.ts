/**
 * Режим «Задачи»: инструменты агента над карточками Kaiten.
 *
 * Каждая запись сначала проходит все проверки, и при любой проблеме агент
 * получает **один** отказ со всем списком: что исправить, какие поля, какого
 * типа, какие значения допустимы и что поле значит (из описания доски).
 * Агент либо догадывается сам, либо спрашивает человека.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Card, CardType } from '../kaiten-client.js';
import { fieldHint, normalizeTitle, titleProblem } from './board-rules.js';
import {
  type AgentKaiten,
  allowedTypes,
  type BoardContext,
  type Catalog,
  creationColumns,
  defaultLane,
  displayValue,
  type FieldInfo,
  isOpen,
  laneTitle,
  toKaitenValue,
  typeRuleFor,
} from './kaiten-agent.js';
import { checkCode, issueCode } from './preview.js';
import { applicable, type CardState, demandedProperties, isSet, needsChildren, type Restriction, verdict } from './restrictions.js';

export interface TaskDeps {
  kaiten: AgentKaiten;
  catalog: Catalog;
  domain: string;
  secret: string;
  describeError: (error: unknown) => string;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Отказ со списком — то, что агент обязан исполнить. */
class Refusal extends Error {
  constructor(
    readonly title: string,
    readonly items: string[],
  ) {
    super(title);
  }
  render(): string {
    return this.items.length === 1 ? `${this.title}: ${this.items[0]}` : `${this.title}:\n${this.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  }
}

const cardRef = z.union([z.number().int().positive(), z.string().min(1)]).describe('id карточки или ссылка на неё');
const fieldsArg = z
  .record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]))
  .optional()
  .describe('Поля по названию, как в правилах доски: {"Источник обращения": "Сайт", "Рейсов в месяц": 30}');

/** id карточки из числа или ссылки. */
export function cardIdOf(ref: number | string): number | null {
  if (typeof ref === 'number') return ref;
  const match = /(\d+)\D*$/.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

export function cardUrl(domain: string, spaceId: number, cardId: number): string {
  return `https://${domain}/space/${spaceId}/card/${cardId}`;
}

/** Строка про поле для отказа: название, тип, варианты, пояснение. */
function describeField(ctx: BoardContext, field: FieldInfo): string {
  const kind =
    field.type === 'select' || field.type === 'multi_select'
      ? `выбор: ${(field.values ?? []).filter((v) => v.condition !== 'inactive').map((v) => v.value).join(', ')}`
      : field.type === 'number'
        ? 'число'
        : field.type === 'string'
          ? 'текст'
          : field.type;
  const hint = ctx.parsed ? fieldHint(ctx.parsed, field.name) : null;
  return `«${field.name}» (${kind})${hint ? ` — ${hint.replace(/[.\s]+$/, '')}` : ''}`;
}

/** Поля от агента → `id_<поле>`; неизвестные и неверные — в список проблем. */
function convertFields(ctx: BoardContext, input: Record<string, unknown> | undefined, problems: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byName = new Map([...ctx.fields.values()].map((f) => [normalizeTitle(f.name), f]));
  for (const [name, value] of Object.entries(input ?? {})) {
    const field = byName.get(normalizeTitle(name));
    if (!field) {
      problems.push(`поля «${name}» на этой доске нет; есть: ${[...ctx.fields.values()].map((f) => f.name).join(', ') || 'нет полей'}`);
      continue;
    }
    const converted = toKaitenValue(field, value);
    if ('problem' in converted) problems.push(converted.problem);
    else out[field.key] = converted.value;
  }
  return out;
}

/** Требования сработавших ограничений — по-человечески. */
function restrictionProblems(ctx: BoardContext, blocking: Restriction[], state: CardState): string[] {
  const problems: string[] = [];
  for (const r of blocking) {
    const missing = demandedProperties(r)
      .filter((key) => !isSet(state.properties[key]))
      .map((key) => ctx.fields.get(key))
      .filter((f): f is FieldInfo => !!f);
    if (missing.length > 0) for (const f of missing) problems.push(`заполните ${describeField(ctx, f)}`);
    const fromPaths = r.conditions.find((c) => c.type === 'prevCardPath');
    if (fromPaths) {
      // В условии — колонки, из которых переносить нельзя; агенту полезнее, откуда можно.
      const forbidden = new Set((fromPaths.data.paths ?? []).map((p) => p.path.columnId));
      const target = r.restrictions.map((x) => x.data.path.columnId);
      const allowed = ctx.board.columns.filter((c) => !forbidden.has(c.id) && !target.includes(c.id)).map((c) => c.title);
      problems.push(`${r.error_text ?? r.name}${allowed.length ? ` (переносить можно из: ${allowed.join(', ')})` : ''}`);
    } else if (r.conditions.some((c) => c.type === 'childCardsDone')) {
      problems.push(r.error_text ?? `${r.name}: сначала завершите дочерние карточки`);
    } else if (missing.length === 0) {
      problems.push(r.error_text ?? r.name);
    }
  }
  return problems;
}

function requireOpen(ctx: BoardContext): void {
  if (ctx.closed.length > 0) throw new Refusal(`Доска «${ctx.board.title}» закрыта для записи агентом — правила в её описании не готовы`, ctx.closed);
}

function requireNotSynced(ctx: BoardContext, card: Card): void {
  if (ctx.parsed?.rules.synced && card.external_id) {
    throw new Refusal('Карточку ведут разработчики через git', ['её описание, поля и этап перезаписываются из репозитория задач — агент может только комментировать (add_comment)']);
  }
}

async function childrenDone(deps: TaskDeps, card: Card): Promise<boolean> {
  for (const id of card.children_ids ?? []) {
    const child = await deps.kaiten.getCard(id);
    if (child.archived) continue;
    const board = await deps.kaiten.getBoard(child.board_id ?? 0);
    if (board.columns.find((c) => c.id === child.column_id)?.type !== 3) return false;
  }
  return true;
}

function resolveType(ctx: BoardContext, name: string | undefined, problems: string[]): CardType | null {
  const allowed = allowedTypes(ctx);
  if (name) {
    const found = allowed.find((t) => normalizeTitle(t.name) === normalizeTitle(name));
    if (!found) problems.push(`тип «${name}» на этой доске агенту не разрешён; можно: ${allowed.map((t) => t.name).join(', ')}`);
    return found ?? null;
  }
  if (allowed.length === 1) return allowed[0];
  const byDefault = allowed.find((t) => t.id === ctx.board.default_card_type_id);
  if (byDefault) return byDefault;
  problems.push(`укажите тип карточки: ${allowed.map((t) => t.name).join(', ')}`);
  return null;
}

async function cardsForDuplicates(deps: TaskDeps, ctx: BoardContext): Promise<Array<{ card: Card; spaceId: number }>> {
  const scope = ctx.parsed?.rules.duplicates ?? 'board';
  if (scope === 'off') return [];
  const boards = scope === 'space' ? ((await deps.kaiten.listSpaces()).find((s) => s.id === ctx.spaceId)?.boards ?? []).map((b) => b.id) : [ctx.board.id];
  const out: Array<{ card: Card; spaceId: number }> = [];
  for (const boardId of boards) {
    const boardCtx = boardId === ctx.board.id ? ctx : { ...ctx, board: await deps.kaiten.getBoard(boardId) };
    for (const card of await deps.kaiten.listCards({ boardId })) if (isOpen(boardCtx, card)) out.push({ card, spaceId: ctx.spaceId });
  }
  return out;
}

// ── чтение ──────────────────────────────────────────────────────────────────

async function boardRulesText(deps: TaskDeps, ctx: BoardContext): Promise<string> {
  const lines: string[] = [`Доска «${ctx.board.title}» (id ${ctx.board.id})`];
  if (ctx.closed.length > 0) {
    lines.push('', 'ЗАКРЫТА для записи агентом:', ...ctx.closed.map((p) => `- ${p}`));
    if (ctx.board.description) lines.push('', 'Описание доски:', ctx.board.description);
    return lines.join('\n');
  }
  lines.push('', ctx.board.description ?? '', '', '— Что проверяет сервер —');
  lines.push(`Создавать можно в колонках: ${creationColumns(ctx).map((c) => c.title).join(', ')}.`);
  for (const type of allowedTypes(ctx)) {
    const rule = typeRuleFor(ctx, type);
    if (!rule) continue;
    const { required } = await deps.catalog.typeFields(type);
    const state: CardState = { typeId: type.id, fromColumnId: null, properties: {} };
    const creation = applicable(ctx.restrictions, 'creation', { boardId: ctx.board.id }).filter((r) => verdict(r, state) !== 'passes');
    const demanded = new Map<string, FieldInfo>();
    for (const f of required) demanded.set(f.key, f);
    for (const r of creation) for (const key of demandedProperties(r)) {
      const f = ctx.fields.get(key);
      if (f) demanded.set(key, f);
    }
    const lane = rule.lane === 'choose' ? `выбрать: ${ctx.board.lanes.map(laneTitle).join(', ')}` : rule.lane === 'default' ? laneTitle(defaultLane(ctx) ?? { id: 0, title: null, sort_order: 0 }) : rule.lane;
    lines.push(
      `Тип «${type.name}»: название «${rule.title}»; дорожка — ${lane}; родитель — ${rule.parent === 'none' ? 'не нужен' : `обязателен, тип «${rule.parent}»`}.`,
      demanded.size ? `  Обязательно при создании: ${[...demanded.values()].map((f) => describeField(ctx, f)).join('; ')}.` : '  Обязательных полей при создании нет.',
    );
  }
  for (const column of ctx.board.columns) {
    const rs = applicable(ctx.restrictions, 'movement', { boardId: ctx.board.id, columnId: column.id });
    for (const r of rs) {
      const fields = demandedProperties(r).map((k) => ctx.fields.get(k)).filter((f): f is FieldInfo => !!f);
      lines.push(`Перенос в «${column.title}»: ${r.error_text ?? r.name}${fields.length ? ` Поля: ${fields.map((f) => f.name).join(', ')}.` : ''}`);
    }
  }
  const rules = ctx.parsed?.rules;
  lines.push(`Дубли: ${rules?.duplicates === 'off' ? 'не проверяются' : rules?.duplicates === 'space' ? 'одинаковое название среди открытых карточек пространства запрещено' : 'одинаковое название среди открытых карточек доски запрещено'}.`);
  if (rules?.synced) lines.push('Карточки с доски ведёт git: существующие агент только комментирует.');
  lines.push('Создание — в два шага: create_card без confirm_code даёт предпросмотр и код; покажите предпросмотр пользователю и повторите вызов с тем же содержимым и кодом.');
  return lines.join('\n');
}

function cardSummary(ctx: BoardContext, domain: string, card: Card): string {
  const column = ctx.board.columns.find((c) => c.id === card.column_id)?.title ?? '?';
  const lane = ctx.board.lanes.find((l) => l.id === card.lane_id);
  const type = ctx.types.find((t) => t.id === card.type_id)?.name ?? '?';
  return `#${card.id} «${card.title ?? ''}» — ${column}${lane ? ` / ${laneTitle(lane)}` : ''}, ${type} — ${cardUrl(domain, ctx.spaceId, card.id)}`;
}

// ── регистрация ─────────────────────────────────────────────────────────────

export function registerTaskTools(server: McpServer, deps: TaskDeps): void {
  const run = async (body: () => Promise<string>): Promise<ToolResult> => {
    try {
      return ok(await body());
    } catch (error) {
      if (error instanceof Refusal) return fail(error.render());
      return fail(deps.describeError(error));
    }
  };
  const loadCard = async (ref: number | string): Promise<{ card: Card; ctx: BoardContext }> => {
    const id = cardIdOf(ref);
    if (id === null) throw new Refusal('Не понял, какая карточка', ['укажите id карточки или ссылку на неё']);
    const card = await deps.kaiten.getCard(id);
    if (!card.board_id) throw new Refusal('Карточка без доски', ['такую карточку агент не ведёт']);
    return { card, ctx: await deps.catalog.boardContext(card.board_id) };
  };

  server.registerTool(
    'list_boards',
    {
      title: 'Доски Kaiten',
      description: 'Пространства и доски, которые видит пользователь, и открыты ли они для записи агентом. Начни с этого, если не знаешь id доски.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const spaces = await deps.kaiten.listSpaces();
        const byUid = new Map(spaces.map((s) => [s.uid, s]));
        const path = (s: (typeof spaces)[number]): string => {
          const parts: string[] = [];
          for (let cur: (typeof spaces)[number] | undefined = s; cur; cur = cur.parent_entity_uid ? byUid.get(cur.parent_entity_uid) : undefined) parts.unshift(cur.title);
          return parts.join(' / ');
        };
        const lines: string[] = [];
        for (const space of spaces.filter((s) => (s.boards ?? []).length > 0).sort((a, b) => path(a).localeCompare(path(b)))) {
          lines.push(path(space));
          for (const { id } of space.boards ?? []) {
            const board = await deps.kaiten.getBoard(id);
            const has = /```ya?ml/.test(board.description ?? '');
            lines.push(`  доска ${id} «${board.title}» — ${has ? 'есть правила для агента' : 'только чтение (нет правил)'}`);
          }
        }
        return lines.join('\n') || 'Досок нет.';
      }),
  );

  server.registerTool(
    'board_rules',
    {
      title: 'Правила доски',
      description: 'Описание доски для агента и всё, что сервер проверит: где и какие карточки заводить, шаблон названия, дорожка, родитель, обязательные поля с вариантами, условия переходов. Прочитай перед созданием и переносом.',
      inputSchema: { board_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    ({ board_id }) => run(async () => boardRulesText(deps, await deps.catalog.boardContext(board_id))),
  );

  server.registerTool(
    'find_cards',
    {
      title: 'Найти карточки',
      description: 'Карточки доски: по части названия и/или колонке. По умолчанию — только открытые.',
      inputSchema: {
        board_id: z.number().int().positive(),
        query: z.string().optional().describe('часть названия'),
        column: z.string().optional().describe('название колонки'),
        include_done: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ board_id, query, column, include_done }) =>
      run(async () => {
        const ctx = await deps.catalog.boardContext(board_id);
        const q = query ? normalizeTitle(query) : null;
        const col = column ? ctx.board.columns.find((c) => normalizeTitle(c.title) === normalizeTitle(column)) : undefined;
        if (column && !col) throw new Refusal('Нет такой колонки', [`колонки доски: ${ctx.board.columns.map((c) => c.title).join(', ')}`]);
        const cards = (await deps.kaiten.listCards({ boardId: board_id }))
          .filter((c) => include_done || isOpen(ctx, c))
          .filter((c) => !col || c.column_id === col.id)
          .filter((c) => !q || normalizeTitle(c.title ?? '').includes(q));
        if (cards.length === 0) return 'Ничего не найдено.';
        const shown = cards.slice(0, 50).map((c) => cardSummary(ctx, deps.domain, c));
        return [...shown, ...(cards.length > 50 ? [`…и ещё ${cards.length - 50}, уточните запрос`] : [])].join('\n');
      }),
  );

  server.registerTool(
    'get_card',
    {
      title: 'Карточка',
      description: 'Карточка целиком: этап, дорожка, тип, поля, описание, чек-листы, родители и дети.',
      inputSchema: { card: cardRef },
      annotations: { readOnlyHint: true },
    },
    ({ card: ref }) =>
      run(async () => {
        const { card, ctx } = await loadCard(ref);
        const lines = [cardSummary(ctx, deps.domain, card)];
        for (const [key, value] of Object.entries(card.properties ?? {})) {
          const field = ctx.fields.get(key) ?? (await deps.catalog.field(Number(key.replace('id_', ''))));
          if (field) lines.push(`${field.name}: ${displayValue(field, value)}`);
        }
        if (card.parents_ids?.length) lines.push(`Родители: ${card.parents_ids.map((id) => `#${id}`).join(', ')}`);
        if (card.children_ids?.length) lines.push(`Дети: ${card.children_ids.map((id) => `#${id}`).join(', ')}`);
        for (const list of card.checklists ?? []) {
          lines.push(`Чек-лист «${list.name ?? ''}»:`, ...(list.items ?? []).map((i) => `  [${i.checked ? 'x' : ' '}] ${i.text ?? ''}`));
        }
        if (card.description) lines.push('', 'Описание:', card.description);
        if (ctx.parsed?.rules.synced && card.external_id) lines.push('', 'Карточку ведёт git: агент может только комментировать.');
        return lines.join('\n');
      }),
  );

  server.registerTool(
    'create_card',
    {
      title: 'Завести карточку',
      description:
        'Заводит карточку по правилам доски, в два шага. Без confirm_code — проверка и предпросмотр с кодом (ничего не записывается). ' +
        'Покажи предпросмотр пользователю; после его согласия повтори вызов с теми же аргументами и confirm_code. ' +
        'Если сервер отказал — исправь всё из списка сам или спроси пользователя одним сообщением.',
      inputSchema: {
        board_id: z.number().int().positive(),
        title: z.string().min(1),
        type: z.string().optional().describe('тип карточки; можно не указывать, если на доске один тип'),
        lane: z.string().optional().describe('дорожка, если правила требуют выбрать'),
        column: z.string().optional().describe('колонка создания, если их несколько'),
        parent: cardRef.optional().describe('родительская карточка, если правила её требуют'),
        fields: fieldsArg,
        description: z.string().optional().describe('описание; без него Kaiten подставит шаблон типа'),
        user_request: z.string().min(1).describe('исходная просьба пользователя дословно — попадёт в комментарий к карточке'),
        confirm_code: z.string().optional().describe('код из предпросмотра'),
      },
    },
    (args) =>
      run(async () => {
        const ctx = await deps.catalog.boardContext(args.board_id);
        requireOpen(ctx);
        const problems: string[] = [];
        const type = resolveType(ctx, args.type, problems);
        const rule = type ? typeRuleFor(ctx, type) : null;

        const columns = creationColumns(ctx);
        const column = args.column ? columns.find((c) => normalizeTitle(c.title) === normalizeTitle(args.column ?? '')) : columns[0];
        if (!column) problems.push(`заводить можно только в: ${columns.map((c) => c.title).join(', ')}`);

        let lane = defaultLane(ctx);
        if (rule) {
          const named = args.lane ? ctx.board.lanes.find((l) => normalizeTitle(laneTitle(l)) === normalizeTitle(args.lane ?? '')) : undefined;
          if (args.lane && !named) problems.push(`дорожки «${args.lane}» нет; есть: ${ctx.board.lanes.map(laneTitle).join(', ')}`);
          if (rule.lane === 'choose') {
            if (!args.lane) problems.push(`выберите дорожку: ${ctx.board.lanes.map(laneTitle).join(', ')}`);
            lane = named;
          } else if (rule.lane !== 'default') {
            const fixed = ctx.board.lanes.find((l) => l.title === rule.lane);
            if (named && named.id !== fixed?.id) problems.push(`тип «${type?.name}» заводится только в дорожку «${rule.lane}»`);
            lane = fixed;
          } else if (named && named.id !== lane?.id) {
            problems.push('дорожку выбирать не нужно — карточка ложится в дорожку по умолчанию');
          }
          const titleIssue = titleProblem(rule.title, args.title);
          if (titleIssue) problems.push(titleIssue);
        }

        let parent: Card | null = null;
        if (rule && rule.parent !== 'none') {
          if (args.parent === undefined) problems.push(`укажите родителя — карточку типа «${rule.parent}»`);
          else {
            const parentId = cardIdOf(args.parent);
            parent = parentId === null ? null : await deps.kaiten.getCard(parentId).catch(() => null);
            const parentType = parent ? ctx.types.find((t) => t.id === parent?.type_id)?.name : undefined;
            if (!parent) problems.push('родительская карточка не найдена или недоступна');
            else if (parentType !== rule.parent) problems.push(`родитель должен быть типа «${rule.parent}», а #${parent.id} — «${parentType ?? '?'}»`);
          }
        } else if (rule && args.parent !== undefined) {
          problems.push(`у типа «${type?.name}» родителя по правилам доски нет`);
        }

        const properties = convertFields(ctx, args.fields, problems);
        if (type) {
          const { required } = await deps.catalog.typeFields(type);
          for (const f of required) if (!isSet(properties[f.key])) problems.push(`заполните ${describeField(ctx, f)}`);
          const state: CardState = { typeId: type.id, fromColumnId: null, properties };
          const blocking = applicable(ctx.restrictions, 'creation', { boardId: ctx.board.id }).filter((r) => verdict(r, state) === 'blocks');
          for (const p of restrictionProblems(ctx, blocking, state)) if (!problems.includes(p)) problems.push(p);
        }

        const wanted = normalizeTitle(args.title);
        const twin = (await cardsForDuplicates(deps, ctx)).find(({ card }) => normalizeTitle(card.title ?? '') === wanted);
        if (twin) problems.push(`такая карточка уже есть: «${twin.card.title}» — ${cardUrl(deps.domain, twin.spaceId, twin.card.id)}. Работайте с ней или дайте другое название`);

        if (problems.length > 0 || !type || !column) throw new Refusal('Карточку не завести — исправьте', problems);

        const payload = {
          board_id: ctx.board.id,
          column_id: column.id,
          lane_id: lane?.id,
          type_id: type.id,
          title: args.title.trim(),
          properties,
          description: args.description,
          parent_id: parent?.id,
          user_request: args.user_request,
        };
        const me = await deps.kaiten.currentUser();
        const preview = [
          `Доска: ${ctx.board.title}; колонка: ${column.title}; дорожка: ${lane ? laneTitle(lane) : '—'}; тип: ${type.name}`,
          `Название: ${payload.title}`,
          ...Object.entries(properties).map(([key, value]) => {
            const f = ctx.fields.get(key);
            return f ? `${f.name}: ${displayValue(f, value)}` : '';
          }).filter(Boolean),
          ...(parent ? [`Родитель: #${parent.id} «${parent.title ?? ''}»`] : []),
          `Ответственный: ${me.full_name?.trim() || me.email || 'вы'}`,
          ...(args.description ? ['Описание:', args.description] : ['Описание: шаблон типа']),
        ].join('\n');

        if (!args.confirm_code) {
          const code = await issueCode(payload, me.id, deps.secret);
          return `ПРЕДПРОСМОТР — ничего не записано.\n${preview}\n\nПокажите это пользователю. После согласия повторите create_card с теми же аргументами и confirm_code: ${code}\nКод действует 10 минут.`;
        }
        const check = await checkCode(args.confirm_code, payload, me.id, deps.secret);
        if (check === 'expired') throw new Refusal('Код истёк', ['вызовите create_card без confirm_code и покажите новый предпросмотр']);
        if (check === 'mismatch') throw new Refusal('Код не подходит', ['содержимое изменилось после предпросмотра — вызовите create_card без confirm_code и покажите новый предпросмотр']);

        const created = await deps.kaiten.createCard({
          title: payload.title,
          board_id: payload.board_id,
          column_id: payload.column_id,
          ...(payload.lane_id ? { lane_id: payload.lane_id } : {}),
          type_id: payload.type_id,
          properties,
          ...(payload.description ? { description: payload.description } : {}),
        });
        const url = cardUrl(deps.domain, ctx.spaceId, created.id);
        const followUps: Array<[string, () => Promise<unknown>]> = [
          ...(parent ? ([[`связь с родителем #${parent.id}`, () => deps.kaiten.addChild(parent.id, created.id)]] as Array<[string, () => Promise<unknown>]>) : []),
          ['метка «агент»', () => deps.kaiten.addTag(created.id, 'агент')],
          ['комментарий с просьбой пользователя', () => deps.kaiten.addComment(created.id, `Заведено ИИ-агентом по просьбе: «${args.user_request}»`)],
          ['ответственный', async () => {
            await deps.kaiten.addMember(created.id, me.id);
            await deps.kaiten.makeResponsible(created.id, me.id);
          }],
        ];
        const failed: string[] = [];
        for (const [label, step] of followUps) {
          try {
            await step();
          } catch {
            failed.push(label);
          }
        }
        return `Карточка заведена: #${created.id} «${payload.title}» — ${url}${failed.length ? `\nНе получилось: ${failed.join(', ')} — доделайте в Kaiten.` : ''}`;
      }),
  );

  server.registerTool(
    'move_card',
    {
      title: 'Перенести карточку',
      description: 'Переводит карточку в другую колонку и/или дорожку этой же доски, сразу с полями, которых требует переход. Сервер заранее проверяет ограничения Kaiten и отказывает полным списком.',
      inputSchema: {
        card: cardRef,
        column: z.string().optional().describe('целевая колонка'),
        lane: z.string().optional().describe('целевая дорожка'),
        fields: fieldsArg,
      },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        requireNotSynced(ctx, card);
        const problems: string[] = [];
        const column = args.column ? ctx.board.columns.find((c) => normalizeTitle(c.title) === normalizeTitle(args.column ?? '')) : undefined;
        if (args.column && !column) problems.push(`колонки «${args.column}» нет; есть: ${ctx.board.columns.map((c) => c.title).join(', ')}`);
        const lane = args.lane ? ctx.board.lanes.find((l) => normalizeTitle(laneTitle(l)) === normalizeTitle(args.lane ?? '')) : undefined;
        if (args.lane && !lane) problems.push(`дорожки «${args.lane}» нет; есть: ${ctx.board.lanes.map(laneTitle).join(', ')}`);
        if (!args.column && !args.lane) problems.push('укажите колонку и/или дорожку');
        const properties = convertFields(ctx, args.fields, problems);
        if (column && column.id !== card.column_id) {
          const rs = applicable(ctx.restrictions, 'movement', { boardId: ctx.board.id, columnId: column.id });
          const state: CardState = {
            typeId: card.type_id ?? 0,
            fromColumnId: card.column_id ?? null,
            properties: { ...(card.properties ?? {}), ...properties },
            ...(needsChildren(rs) ? { childrenDone: await childrenDone(deps, card) } : {}),
          };
          const blocking = rs.filter((r) => verdict(r, state) === 'blocks');
          problems.push(...restrictionProblems(ctx, blocking, state));
        }
        if (problems.length > 0) throw new Refusal(`Карточку #${card.id} не перенести — исправьте`, problems);
        await deps.kaiten.updateCard(card.id, {
          ...(column ? { column_id: column.id } : {}),
          ...(lane ? { lane_id: lane.id } : {}),
          ...(Object.keys(properties).length ? { properties } : {}),
        });
        const after = await deps.kaiten.getCard(card.id);
        return `Готово: ${cardSummary(ctx, deps.domain, after)}`;
      }),
  );

  server.registerTool(
    'update_card',
    {
      title: 'Изменить поля или описание',
      description: 'Меняет поля и/или описание карточки. Название, ответственного, участников и сроки агент не меняет.',
      inputSchema: { card: cardRef, fields: fieldsArg, description: z.string().optional() },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        requireNotSynced(ctx, card);
        const problems: string[] = [];
        const properties = convertFields(ctx, args.fields, problems);
        if (!Object.keys(properties).length && args.description === undefined && problems.length === 0) problems.push('нечего менять: передайте fields и/или description');
        if (problems.length > 0) throw new Refusal(`Карточку #${card.id} не изменить — исправьте`, problems);
        await deps.kaiten.updateCard(card.id, {
          ...(Object.keys(properties).length ? { properties } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
        });
        return `Готово: ${cardSummary(ctx, deps.domain, await deps.kaiten.getCard(card.id))}`;
      }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Комментарий',
      description: 'Добавляет комментарий к карточке от имени пользователя.',
      inputSchema: { card: cardRef, text: z.string().min(1) },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        await deps.kaiten.addComment(card.id, args.text);
        return `Комментарий добавлен к #${card.id}.`;
      }),
  );

  server.registerTool(
    'checklist_item',
    {
      title: 'Пункт чек-листа',
      description: 'Отмечает пункт чек-листа (или снимает отметку); если пункта нет — добавляет его. Чек-лист без такого названия будет создан.',
      inputSchema: { card: cardRef, checklist: z.string().min(1), item: z.string().min(1), checked: z.boolean().optional() },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        requireNotSynced(ctx, card);
        const list = (card.checklists ?? []).find((l) => normalizeTitle(l.name ?? '') === normalizeTitle(args.checklist));
        const item = list?.items?.find((i) => normalizeTitle(i.text ?? '') === normalizeTitle(args.item));
        if (list && item?.id !== undefined) {
          await deps.kaiten.updateChecklistItem(card.id, list.id, item.id, { checked: args.checked ?? true });
          return `Пункт «${item.text}» ${args.checked === false ? 'снят' : 'отмечен'}.`;
        }
        const listId = list?.id ?? (await deps.kaiten.createChecklistNamed(card.id, args.checklist)).id;
        await deps.kaiten.addChecklistItem(listId, { text: args.item, checked: args.checked ?? false }, (list?.items?.length ?? 0) + 1);
        return `Пункт «${args.item}» добавлен в «${args.checklist}».`;
      }),
  );

  server.registerTool(
    'link_parent',
    {
      title: 'Связать с родителем',
      description: 'Делает карточку дочерней для другой. Тип родителя проверяется по правилам доски.',
      inputSchema: { card: cardRef, parent: cardRef },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        const parentId = cardIdOf(args.parent);
        const parent = parentId === null ? null : await deps.kaiten.getCard(parentId).catch(() => null);
        if (!parent) throw new Refusal('Родитель не найден', ['проверьте id или ссылку']);
        const type = ctx.types.find((t) => t.id === card.type_id);
        const rule = type ? typeRuleFor(ctx, type) : null;
        const parentType = ctx.types.find((t) => t.id === parent.type_id)?.name;
        if (rule && rule.parent !== 'none' && parentType !== rule.parent) {
          throw new Refusal('Не тот родитель', [`для типа «${type?.name}» родитель — «${rule.parent}», а #${parent.id} — «${parentType ?? '?'}»`]);
        }
        if (card.parents_ids?.includes(parent.id)) return `#${card.id} уже дочерняя для #${parent.id}.`;
        await deps.kaiten.addChild(parent.id, card.id);
        return `#${card.id} теперь дочерняя для #${parent.id}.`;
      }),
  );

  server.registerTool(
    'block_card',
    {
      title: 'Заблокировать',
      description: 'Ставит блокировку на карточку с причиной (чего ждём и от кого).',
      inputSchema: { card: cardRef, reason: z.string().min(3) },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        requireNotSynced(ctx, card);
        await deps.kaiten.addBlocker(card.id, args.reason);
        return `#${card.id} заблокирована: ${args.reason}`;
      }),
  );
}
