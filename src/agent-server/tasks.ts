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
import { fieldHint, normalizeTitle, parseBoardDescription, titleProblem } from './board-rules.js';
import {
  type AgentKaiten,
  allowedTypes,
  type BoardContext,
  type BoardFull,
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
import { ALLOWED_EXTENSIONS, decodeBase64, fileProblems, MAX_INLINE_BYTES } from './card-files.js';
import { addWorkingDays, isDate, todayIn, workingDaysText } from './due.js';
import { type CommentPending, savePending, type UploadPending } from './pending.js';
import { checkCode, issueCode } from './preview.js';
import { Refusal, runTool } from './refusal.js';
import type { Store } from './store.js';
import { applicable, type CardState, demandedProperties, isSet, needsChildren, type Restriction, verdict } from './restrictions.js';

export interface TaskDeps {
  kaiten: AgentKaiten;
  catalog: Catalog;
  domain: string;
  secret: string;
  describeError: (error: unknown) => string;
  /** Для подтверждений человеком (комментарий заказчику, страница загрузки); без них такие действия — отказ. */
  store?: Store;
  publicUrl?: string;
  agentKey?: string;
  /** Часы — подменяются в тестах (срок «+N рабочих дней»). */
  now?: () => Date;
}

interface Person {
  id: number;
  full_name?: string | null;
  email?: string | null;
  username?: string | null;
}

const personLabel = (p: Person): string => p.full_name?.trim() || p.email || `#${p.id}`;

/**
 * Человек по имени, части имени или почте — среди тех, у кого есть доступ к
 * пространству доски. Не нашёлся или нашлось несколько — проблема в отказ.
 */
async function findPerson(deps: TaskDeps, ctx: BoardContext, query: string, me: Person, problems: string[]): Promise<Person | null> {
  const people: Person[] = await deps.catalog.people(ctx.spaceId);
  const all = people.some((p) => p.id === me.id) ? people : [...people, me];
  const q = normalizeTitle(query);
  const mail = query.trim().toLowerCase();
  let found = all.filter((p) => (p.email ?? '').toLowerCase() === mail || normalizeTitle(p.full_name ?? '') === q || (p.username ? normalizeTitle(p.username) === q : false));
  if (found.length === 0) {
    const words = q.split(' ').filter(Boolean);
    found = all.filter((p) => {
      const name = normalizeTitle(p.full_name ?? '').split(' ');
      return words.length > 0 && words.every((w) => name.some((n) => n.startsWith(w)));
    });
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) problems.push(`«${query}» — несколько человек: ${found.map((p) => `${personLabel(p)}${p.email ? ` (${p.email})` : ''}`).join(', ')}; назовите одного, можно почтой`);
  else problems.push(`«${query}» нет среди тех, у кого есть доступ к пространству доски; есть: ${all.slice(0, 30).map(personLabel).join(', ')}${all.length > 30 ? '…' : ''}`);
  return null;
}

/** Почему комментарий требует подтверждения человеком; `null` — не требует. */
function commentConfirmReason(ctx: BoardContext, card: Card): string | null {
  if (card.service_id !== null && card.service_id !== undefined && card.service_id !== '') return 'карточка — обращение Service Desk, комментарий уйдёт заказчику';
  if (ctx.parsed?.rules.comments === 'confirm') return 'на этой доске комментарии получают гости или заказчики';
  return null;
}

const confirmTail = 'Ссылка одноразовая, действует 30 минут. Сами по ней не переходите.';

export const cardRef = z.union([z.number().int().positive(), z.string().min(1)]).describe('id карточки или ссылка на неё');
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

/** Адрес карточки в интерфейсе Kaiten (снят из браузера 16.10.2026). */
export function cardUrl(domain: string, spaceId: number, cardId: number): string {
  return `https://${domain}/space/${spaceId}/boards/card/${cardId}`;
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
  if (ctx.closed.length > 0) throw new Refusal(`Доска «${ctx.board.title}» закрыта для записи агентом`, ctx.closed);
}

/** Предупреждения об описании доски — хвостом к ответу: подсказка, не отказ. */
function warningLines(ctx: BoardContext): string[] {
  return ctx.warnings.length ? ['', 'Предупреждения об описании доски (запись не мешают):', ...ctx.warnings.map((w) => `- ${w}`)] : [];
}

/**
 * Состояние доски одной строкой для list_boards — по тем же правилам разбора.
 * Полную проверку (типы, колонки) делает board_rules; здесь — без лишних
 * запросов, но доска на умолчаниях без типа по умолчанию — закрыта и здесь.
 */
export function boardState(board: Pick<BoardFull, 'description' | 'default_card_type_id'>): string {
  const parsed = parseBoardDescription(board.description);
  if (!parsed.ok) return `закрыта: ${parsed.problems[0]}`;
  if (parsed.value.rules.access === 'read') return 'только чтение (access: read)';
  if (!parsed.value.defaults) return 'есть правила для агента';
  return board.default_card_type_id ? 'правила по умолчанию' : 'закрыта: у доски нет типа карточки по умолчанию';
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
  if (ctx.board.description) lines.push('', ctx.board.description);
  if (ctx.parsed?.defaults) lines.push('', 'Блока правил у доски нет — действуют правила по умолчанию.');
  lines.push('', '— Что проверяет сервер —');
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
    const due =
      rule.due === 'none'
        ? 'не ставится'
        : `${rule.due === 'required' ? 'обязателен' : 'можно указать'} (due, ГГГГ-ММ-ДД)${rule.due_default ? `; не назван — +${workingDaysText(rule.due_default)}` : ''}; потом агент его не меняет`;
    lines.push(
      `Тип «${type.name}»: название ${rule.title ? `«${rule.title}»` : 'свободное'}; дорожка — ${lane}; родитель — ${rule.parent === 'none' ? 'не нужен' : `обязателен, тип «${rule.parent}»`}.`,
      demanded.size ? `  Обязательно при создании: ${[...demanded.values()].map((f) => describeField(ctx, f)).join('; ')}.` : '  Обязательных полей при создании нет.',
      `  Ответственный: ${rule.responsible === 'required' ? 'обязательно назвать (responsible) — кому поручено' : 'вы, если пользователь не назвал другого (responsible)'}. Срок: ${due}.`,
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
  if (rules?.synced) lines.push('Карточки с external_id ведёт git: такие агент только комментирует.');
  lines.push(
    rules?.comments === 'confirm'
      ? 'Комментарии: только после подтверждения человеком — на доске их получают гости или заказчики.'
      : 'Комментарий к обращению Service Desk — только после подтверждения человеком: он уходит заказчику.',
  );
  lines.push('Создание — в два шага: create_card без confirm_code даёт предпросмотр и код; покажите предпросмотр пользователю и повторите вызов с тем же содержимым и кодом.');
  lines.push(...warningLines(ctx));
  return lines.join('\n');
}

function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'размер неизвестен';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function cardSummary(ctx: BoardContext, domain: string, card: Card): string {
  const column = ctx.board.columns.find((c) => c.id === card.column_id)?.title ?? '?';
  const lane = ctx.board.lanes.find((l) => l.id === card.lane_id);
  const type = ctx.types.find((t) => t.id === card.type_id)?.name ?? '?';
  return `#${card.id} «${card.title ?? ''}» — ${column}${lane ? ` / ${laneTitle(lane)}` : ''}, ${type} — ${cardUrl(domain, ctx.spaceId, card.id)}`;
}

// ── регистрация ─────────────────────────────────────────────────────────────

export function registerTaskTools(server: McpServer, deps: TaskDeps): void {
  const run = (body: () => Promise<string>) => runTool(body, deps.describeError);
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
            lines.push(`  доска ${id} «${board.title}» — ${boardState(board)}`);
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
          // Порядок — как в интерфейсе: в ответе API пункты идут не по `sort_order`.
          const items = [...(list.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
          lines.push(`Чек-лист «${list.name ?? ''}»:`, ...items.map((i) => `  [${i.checked ? 'x' : ' '}] ${i.text ?? ''}`));
        }
        const responsible = (card.members ?? []).filter((m) => m.type === 2).map((m) => m.full_name?.trim()).filter(Boolean);
        if (responsible.length) lines.push(`Ответственный: ${responsible.join(', ')}`);
        if (card.due_date) lines.push(`Срок: ${card.due_date.slice(0, 10)}`);
        const files = card.files ?? [];
        if (files.length > 0) lines.push(`Файлы (открыть — в карточке Kaiten): ${files.map((f) => `${f.name} (${fileSize(Number(f.size))})`).join(', ')}`);
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
        responsible: z.string().optional().describe('кому поручено: имя или почта; не указан — вы сами (если правила типа не требуют назвать)'),
        due: z.string().optional().describe('срок датой ГГГГ-ММ-ДД, если правила типа его разрешают; после создания срок не меняется'),
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
          const titleIssue = rule.title ? titleProblem(rule.title, args.title) : null;
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

        const me = await deps.kaiten.currentUser();
        let responsible: Person = me;
        if (args.responsible !== undefined && args.responsible.trim()) {
          responsible = (await findPerson(deps, ctx, args.responsible, me, problems)) ?? me;
        } else if (rule?.responsible === 'required') {
          problems.push('укажите ответственного (responsible): кому поручено — имя или почта; если себе — ваше имя');
        }

        const today = todayIn(me.timezone, (deps.now ?? (() => new Date()))());
        let due: string | null = null;
        let dueNote = '';
        if (rule && type) {
          if (args.due !== undefined) {
            if (rule.due === 'none') problems.push(`у типа «${type.name}» срок при создании не ставится — уберите due`);
            else if (!isDate(args.due.trim())) problems.push('срок (due) — дата ГГГГ-ММ-ДД, например 2026-10-21');
            else if (args.due.trim() < today) problems.push(`срок ${args.due.trim()} уже прошёл: сегодня ${today}`);
            else due = args.due.trim();
          } else if (rule.due !== 'none' && rule.due_default) {
            due = addWorkingDays(today, rule.due_default);
            dueNote = ` — по умолчанию, +${workingDaysText(rule.due_default)}`;
          } else if (rule.due === 'required') {
            problems.push('укажите срок (due) датой ГГГГ-ММ-ДД — спросите пользователя: после создания срок не изменить');
          }
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
          // В коде предпросмотра — и кому, и срок: подтверждённый код не переписать на другого человека.
          responsible_id: responsible.id,
          due_date: due,
          user_request: args.user_request,
        };
        const quietComments = ctx.parsed?.rules.comments === 'confirm';
        const preview = [
          `Доска: ${ctx.board.title}; колонка: ${column.title}; дорожка: ${lane ? laneTitle(lane) : '—'}; тип: ${type.name}`,
          `Название: ${payload.title}`,
          ...Object.entries(properties).map(([key, value]) => {
            const f = ctx.fields.get(key);
            return f ? `${f.name}: ${displayValue(f, value)}` : '';
          }).filter(Boolean),
          ...(parent ? [`Родитель: #${parent.id} «${parent.title ?? ''}»`] : []),
          `Ответственный: ${personLabel(responsible)}`,
          ...(responsible.id !== me.id ? [`Участник: ${personLabel(me)} — автор поручения`] : []),
          ...(due ? [`Срок: ${due}${dueNote}`] : []),
          ...(quietComments ? ['Комментарий с просьбой пользователя не пишем: на доске комментарии получают гости или заказчики.'] : []),
          ...(args.description ? ['Описание:', args.description] : ['Описание: шаблон типа']),
          ...warningLines(ctx),
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
          ...(due ? { due_date: due } : {}),
        });
        const url = cardUrl(deps.domain, ctx.spaceId, created.id);
        type Step = [string, () => Promise<unknown>];
        const followUps: Step[] = [
          ...(parent ? ([[`связь с родителем #${parent.id}`, () => deps.kaiten.addChild(parent.id, created.id)]] as Step[]) : []),
          ['метка «агент»', () => deps.kaiten.addTag(created.id, 'агент')],
          ...(quietComments ? [] : ([['комментарий с просьбой пользователя', () => deps.kaiten.addComment(created.id, `Заведено ИИ-агентом по просьбе: «${args.user_request}»`)]] as Step[])),
          [`ответственный — ${personLabel(responsible)}`, async () => {
            await deps.kaiten.addMember(created.id, responsible.id);
            await deps.kaiten.makeResponsible(created.id, responsible.id);
          }],
          ...(responsible.id !== me.id ? ([['вы — участником карточки', () => deps.kaiten.addMember(created.id, me.id)]] as Step[]) : []),
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
        return [`Готово: ${cardSummary(ctx, deps.domain, after)}`, ...warningLines(ctx)].join('\n');
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
      description:
        'Добавляет комментарий к карточке от имени пользователя. Если комментарий уйдёт заказчику или гостю (Service Desk, доска с гостями), ' +
        'сервер не отправит его сразу, а даст ссылку: пользователь откроет её и нажмёт «Отправить».',
      inputSchema: { card: cardRef, text: z.string().min(1) },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        const reason = commentConfirmReason(ctx, card);
        if (!reason) {
          await deps.kaiten.addComment(card.id, args.text);
          return `Комментарий добавлен к #${card.id}.`;
        }
        if (!deps.store || !deps.publicUrl || !deps.agentKey) {
          throw new Refusal('Комментарий не отправлен', [`${reason} — нужно подтверждение человеком, а на этом подключении оно недоступно; напишите комментарий в Kaiten сами`]);
        }
        const me = await deps.kaiten.currentUser();
        const pending: CommentPending = {
          kind: 'comment',
          userId: me.id,
          agentKey: deps.agentKey,
          by: personLabel(me),
          cardId: card.id,
          cardTitle: card.title ?? '',
          boardTitle: ctx.board.title,
          reason,
          text: args.text,
        };
        const id = await savePending(deps.store, deps.secret, pending);
        return (
          `НУЖНО ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА — комментарий к #${card.id} пока не отправлен: ${reason}.\n\n` +
          `Покажите пользователю ссылку и попросите открыть её и нажать «Отправить»: ${deps.publicUrl.replace(/\/+$/, '')}/confirm/${id}\n${confirmTail}`
        );
      }),
  );

  server.registerTool(
    'attach_file',
    {
      title: 'Приложить файл',
      description:
        `Кладёт файл в карточку. Файл у вас — передайте name и content_base64 (до ${MAX_INLINE_BYTES / 1024 / 1024} МБ). ` +
        'Файл у пользователя (приложил в чат, лежит у него на компьютере) — вызовите без content_base64: сервер даст одноразовую ссылку, ' +
        `пользователь откроет её и выберет файл (до 10 МБ). Типы: ${ALLOWED_EXTENSIONS.join(', ')}.`,
      inputSchema: {
        card: cardRef,
        name: z.string().optional().describe('имя файла с расширением, например «счёт 2026-10.pdf»; только вместе с content_base64'),
        content_base64: z.string().optional().describe('содержимое файла в base64'),
      },
    },
    (args) =>
      run(async () => {
        const { card, ctx } = await loadCard(args.card);
        requireOpen(ctx);
        if (!card.uid) throw new Refusal('Файл не приложить', ['Kaiten не отдал адрес файлов карточки — приложите файл в Kaiten сами']);
        const existing = (card.files ?? []).map((f) => f.name);
        if (args.content_base64 !== undefined) {
          const problems: string[] = [];
          const name = args.name?.trim() ?? '';
          if (!name) problems.push('укажите name — имя файла с расширением');
          const bytes = decodeBase64(args.content_base64);
          if (!bytes) problems.push('content_base64 — не base64');
          else if (name) problems.push(...fileProblems(name, bytes, existing, MAX_INLINE_BYTES));
          if (problems.length > 0 || !bytes) throw new Refusal('Файл не приложен — исправьте', problems);
          await deps.kaiten.uploadCardFile(card.uid, name, bytes);
          return `Файл «${name}» приложен к #${card.id}.`;
        }
        if (!deps.store || !deps.publicUrl || !deps.agentKey) {
          throw new Refusal('Страница загрузки на этом подключении недоступна', ['передайте файл в content_base64 или приложите его в Kaiten сами']);
        }
        const me = await deps.kaiten.currentUser();
        const pending: UploadPending = { kind: 'upload', userId: me.id, agentKey: deps.agentKey, by: personLabel(me), cardId: card.id, cardUid: card.uid, cardTitle: card.title ?? '' };
        const id = await savePending(deps.store, deps.secret, pending);
        return (
          `Файл выберет пользователь. Покажите ему ссылку: ${deps.publicUrl.replace(/\/+$/, '')}/upload/${id}\n` +
          `До 10 МБ; типы: ${ALLOWED_EXTENSIONS.join(', ')}. ${confirmTail}`
        );
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
