/**
 * Карточки, заведённые в интерфейсе Kaiten, становятся файлами задач (этап 2c)
 * — чистая часть.
 *
 * ЧЬЯ КАРТОЧКА. Файл есть, если с карточкой совпал `tracker` задачи или её
 * `external_id` — это id задачи. Переносится только карточка без
 * `external_id`: её завели руками. Карточка с чужим `external_id` (заливка
 * пилота, пробные прогоны в другом хранилище) в отчёт, а не в задачи: иначе
 * тестовые карточки стали бы задачами настоящего репозитория. Не трогаем
 * архивные и карточки из `ignoreCards`.
 *
 * ID ЗАДАЧИ ВЫВОДИТСЯ ИЗ КАРТОЧКИ (`adoptId`: дата создания карточки + её id),
 * а не случаен. Перенос помечает карточку этим id в `external_id`, поэтому:
 *   · обрыв после пометки, до записи файла, — следующий проход узнаёт свою
 *     пометку и переносит заново, уже без комментария;
 *   · два разработчика, перенёсшие одну карточку одновременно (замок Kaiten —
 *     на машину, не на всех), получают одну задачу: операция `adopt`
 *     пропускает id, который уже есть.
 *
 * ЧТО ПОПАДАЕТ В ФАЙЛ: тело — описание карточки; «Суть», «Репозиторий»,
 * тип, статус (колонка), приоритет, команда, срок — из карточки; эпик — если
 * родитель карточки — эпик; `created_by` — автор карточки по почте из реестра
 * людей, иначе его имя в Kaiten. `created_via` не ставим: задача родилась не
 * в CLI. Чего не хватает для файла (нет «Сути», «Репозитория», тип или
 * колонка не из конфига) — в отчёт словами «что поправить в карточке».
 *
 * ПОРЯДОК (выполняет `kaiten-sync.ts`): комментарий с исходной постановкой →
 * пометка `external_id` → файл. Описание карточки на этом проходе не
 * меняется: его перерисует из файла следующий проход обычным обновлением
 * (строка Q41, первая доставка), когда файл уже в хранилище, — исходный
 * текст не пропадёт ни при каком обрыве. Обрыв между комментарием и пометкой
 * даёт второй комментарий — лучше, чем ни одного. Чек-листы людей (без
 * «Агент · ») не трогаются ни здесь, ни при обновлении.
 */

import type { ConfigMapping } from '../config.js';
import { serializeTaskDocument } from './document.js';
import { localDate, type CardView } from './kaiten-sync-plan.js';
import { lintTask } from './lint.js';
import { hasContent, stripTemplateHints } from './skeleton.js';
import { CLOSED_STATUSES, FrontmatterSchema, PRIORITIES, STATUSES, TASK_TYPES, type TaskStatus, type TaskType } from './schema.js';
import { slugify, type AdoptItem } from './task-ops.js';
import type { TaskRecord } from './tasks-index.js';
import { deriveId } from './ulid.js';

/**
 * id задачи из карточки: одинаковый при каждом вычислении и на любой машине —
 * дата создания по UTC, а не по местному времени (иначе у разработчиков в
 * разных часовых поясах одна карточка дала бы две задачи).
 */
export function adoptId(cardId: number, createdAt: string): string {
  const d = new Date(createdAt);
  return deriveId(`kaiten-card:${cardId}`, Number.isNaN(d.getTime()) ? createdAt.slice(0, 10) : d.toISOString().slice(0, 10));
}

export interface AdoptCandidate {
  card: CardView;
  id: string;
  type: TaskType;
  status: TaskStatus;
  /** Ключ карточки эпика-родителя. */
  epic?: string;
  /** Карточка уже помечена этим id, а файла нет — комментарий уже оставлен. */
  recovery: boolean;
}

export interface AdoptPlan {
  candidates: AdoptCandidate[];
  /** Карточка заведена руками, но для файла чего-то не хватает — что поправить. */
  problems: string[];
  /** `external_id` не наш и не совпал ни с одной задачей — не трогаем. */
  foreign: string[];
}

export interface AdoptInput {
  tasks: readonly TaskRecord[];
  cards: readonly CardView[];
  mapping: ConfigMapping;
  ignore: readonly number[];
  /** Пробный прогон: только эти карточки; пустое множество — ни одной. */
  onlyCards?: ReadonlySet<number>;
}

const key = (id: number): string => `id_${id}`;

function nameOf<T extends string>(values: Partial<Record<T, number>> | Record<string, number> | undefined, allowed: readonly T[] | null, id: number | undefined): T | undefined {
  if (id === undefined) return undefined;
  const hit = Object.entries(values ?? {}).find(([name, value]) => value === id && (allowed === null || (allowed as readonly string[]).includes(name)));
  return hit?.[0] as T | undefined;
}

function firstId(value: unknown): number | undefined {
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : undefined;
}

export function label(card: CardView): string {
  return `«${card.title.trim()}» (${card.id})`;
}

/** Какие карточки доски — ещё не задачи, и можно ли их перенести. */
export function planAdoption(input: AdoptInput): AdoptPlan {
  const { mapping } = input;
  const plan: AdoptPlan = { candidates: [], problems: [], foreign: [] };
  const trackers = new Set(input.tasks.map((t) => t.fm.tracker).filter((t): t is string => t !== undefined));
  const ids = new Set(input.tasks.map((t) => t.fm.id));
  const ignore = new Set(input.ignore);

  const eligible = input.cards.filter((card) => {
    if (card.archived || ignore.has(card.id) || trackers.has(String(card.id))) return false;
    if (card.externalId !== null && ids.has(card.externalId)) return false;
    if (input.onlyCards && !input.onlyCards.has(card.id)) return false;
    const ours = card.createdAt !== undefined && card.externalId === adoptId(card.id, card.createdAt);
    if (card.externalId !== null && !ours) {
      plan.foreign.push(`${label(card)}: ${card.externalId}`);
      return false;
    }
    return true;
  });
  const typeOf = (card: CardView | undefined): TaskType | undefined => nameOf<TaskType>(mapping.types, TASK_TYPES, card?.typeId);

  const ready: Array<Omit<AdoptCandidate, 'epic'>> = [];
  for (const card of eligible) {
    const fix: string[] = [];
    const type = typeOf(card);
    const status = nameOf<TaskStatus>(mapping.columns, STATUSES, card.columnId);
    if (type === undefined) fix.push('тип карточки — не Epic/Story/Tech/Bug/Spike');
    if (status === undefined) fix.push('карточка в колонке, которой нет у задач');
    const summary = mapping.summaryProperty ? card.properties[key(mapping.summaryProperty.id)] : undefined;
    if (typeof summary !== 'string' || !summary.trim()) fix.push('заполните «Суть»');
    const repo = mapping.repoProperty ? nameOf<string>(mapping.repoProperty.values, null, firstId(card.properties[key(mapping.repoProperty.id)])) : undefined;
    if (type !== 'epic' && repo === undefined) fix.push('выберите «Репозиторий»');
    if (!card.title.trim()) fix.push('нет заголовка');
    if (card.createdAt === undefined) fix.push('Kaiten не отдал дату создания');
    if (fix.length > 0 || type === undefined || status === undefined || card.createdAt === undefined) {
      plan.problems.push(`${label(card)}: ${fix.join('; ')}`);
      continue;
    }

    ready.push({ card, id: adoptId(card.id, card.createdAt), type, status, recovery: card.externalId !== null });
  }

  // Родитель — эпик: уже задача (по ключу) или карточка, переносимая в этом же проходе.
  const adoptedEpics = new Set(ready.filter((c) => c.type === 'epic').map((c) => c.card.id));
  for (const candidate of ready) {
    const parentId =
      candidate.type === 'epic'
        ? undefined
        : candidate.card.parents.find(
            (p) => !ignore.has(p) && (adoptedEpics.has(p) || input.tasks.some((t) => t.fm.type === 'epic' && t.fm.tracker === String(p))),
          );
    plan.candidates.push({ ...candidate, ...(parentId !== undefined ? { epic: String(parentId) } : {}) });
  }
  // Эпики — первыми: так их файлы появятся раньше файлов задач в одном пакете.
  plan.candidates.sort((a, b) => Number(b.type === 'epic') - Number(a.type === 'epic'));
  return plan;
}

/** Что читается только из карточки целиком (`GET /cards/{id}`). */
export interface FullCard {
  description: string | null;
  ownerEmail?: string | null;
  ownerName?: string | null;
  /** Формат описания, если Kaiten его отдал; 1 — markdown. */
  textFormat?: number;
}

export interface AdoptContext {
  mapping: ConfigMapping;
  /** Почта → человек (`convert/people.json`). */
  people: Readonly<Record<string, string>>;
  /** Дата операции `YYYY-MM-DD`. */
  date: string;
}

/**
 * Файл задачи из карточки — или что поправить в карточке. `comment` —
 * исходная постановка для первого комментария; `null`, если в описании нет
 * ничего, кроме заголовков и подсказок шаблона.
 */
export function adoptedTask(candidate: AdoptCandidate, full: FullCard, ctx: AdoptContext): { item: AdoptItem; comment: string | null } | { problem: string } {
  const { card, type, status } = candidate;
  const { mapping } = ctx;
  if (full.textFormat !== undefined && full.textFormat !== 1) return { problem: 'описание карточки не в markdown — перенесите вручную' };
  const email = full.ownerEmail?.trim().toLowerCase();
  const createdBy = (email ? ctx.people[email] : undefined) ?? full.ownerName?.trim();
  if (!createdBy) return { problem: 'Kaiten не отдал автора карточки' };

  const prop = (id: number | undefined): unknown => (id === undefined ? undefined : card.properties[key(id)]);
  const pick = (values: Record<string, number> | undefined, allowed: readonly string[] | null, id: number | undefined): string | undefined =>
    nameOf<string>(values, allowed, firstId(prop(id)));
  const due = card.dueDate ? localDate(card.dueDate) : undefined;
  const parsed = FrontmatterSchema.safeParse({
    id: candidate.id,
    tracker: String(card.id),
    title: card.title.trim(),
    summary: String(prop(mapping.summaryProperty?.id) ?? '').trim(),
    type,
    status,
    repo: pick(mapping.repoProperty?.values, null, mapping.repoProperty?.id),
    epic: candidate.epic,
    priority: pick(mapping.priorityProperty?.values, PRIORITIES, mapping.priorityProperty?.id),
    team: pick(mapping.teamProperty?.values, null, mapping.teamProperty?.id),
    created: localDate(candidate.card.createdAt ?? ctx.date),
    created_by: createdBy,
    updated: ctx.date,
    planning: due ? { due } : undefined,
  });
  if (!parsed.success) return { problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };

  const original = (full.description ?? '').replace(/\r\n/g, '\n').trim();
  const description = stripTemplateHints(original);
  const text = serializeTaskDocument(parsed.data, description ? `\n${description}\n` : '');
  const slug = slugify(card.title) || `card-${card.id}`;
  const closed = CLOSED_STATUSES.includes(status);
  const closedMonth = closed ? localDate(card.columnChangedAt ?? ctx.date).slice(0, 7) : undefined;
  const path = closed ? `archive/${closedMonth}/${slug}.md` : `active/${slug}.md`;
  const errors = lintTask(text, { path }).issues.filter((i) => i.level === 'error');
  if (errors.length > 0) return { problem: errors.map((i) => i.message).join('; ') };
  return { item: { slug, text, ...(closedMonth ? { closedMonth } : {}) }, comment: hasContent(description) ? originalComment(original) : null };
}

/** Первый комментарий карточки — исходная постановка (Q41). */
export function originalComment(description: string): string {
  return `Исходная постановка — до переноса карточки в репозиторий задач. Дальше описание обновляется из задачи; правки — комментарием.\n\n${description.trim()}`;
}
