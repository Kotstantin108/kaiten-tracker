/**
 * Выполнение плана синхронизации с Kaiten (`core/kaiten-sync-plan.ts`).
 *
 * Возобновляемо: всё, что дошло до Kaiten, возвращается одной пакетной
 * операцией `synced` (ключи созданных карточек, доставленные хеши) — её
 * записывают в журнал хранилища и отправляют общим, как любую запись. Обрыв
 * посередине безопасен:
 *   · создание сначала ищет карточку по `external_id` = id задачи — повтор
 *     найдёт созданную, а не сделает вторую;
 *   · обновление идемпотентно: те же поля и описание ещё раз;
 *   · пункты чек-листов только добавляются и отмечаются, не удаляются.
 * Одновременные прогоны на одном хранилище исключает замок (`KAITEN_LOCK`
 * берут фон, `pull` и скрипт владельца) — от них `external_id` не спасает.
 *
 * Сухой прогон с подробностями читает карточки, которые план обновит, и
 * считает по каждой, что станет с чек-листами: сколько пунктов добавится,
 * отметится, снимется, какие галочки Kaiten останутся.
 *
 * Ошибка одной задачи не останавливает остальные: она — в `errors`, словами
 * задачи. Токен в сообщения не попадает: клиент его не печатает, а текст
 * ошибки берётся из ответа Kaiten (для ограничений доски это `error_text`,
 * который написал владелец).
 *
 * Карточки, заведённые в интерфейсе, становятся задачами (`core/kaiten-adopt.ts`):
 * комментарий с исходной постановкой, пометка `external_id`, операция
 * `adopt`. Описание перерисует следующий проход.
 *
 * НЕ ПРОВЕРЕНО ЖИВЬЁМ (по документации): создание карточки сразу в «Сделано»
 * при ограничениях доски, комментарий (`addComment`), запись `external_id`
 * существующей карточке. Первый живой вызов — на одной тестовой карточке
 * (`npm run kaiten-sync -- --only <задача или id карточки>`) с перечитыванием.
 */

import { adoptedTask, label, originalComment, planAdoption, type AdoptPlan, type FullCard } from './core/kaiten-adopt.js';
import {
  diffChecklists,
  localDate,
  emptyDiff,
  planKaitenSync,
  type CardView,
  type ChecklistDiff,
  type ExistingChecklist,
  type PlanInput,
  type SyncAction,
  type SyncPlan,
} from './core/kaiten-sync-plan.js';
import type { AdoptItem, Op, SyncedItem } from './core/task-ops.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { KaitenApiError, type Card, type KaitenClient } from './kaiten-client.js';

export interface SyncOp {
  op: Op;
  what: string;
}

export interface SyncError {
  what: string;
  message: string;
}

export interface SyncRun {
  plan: SyncPlan;
  /** Карточки без файла — в задачи. */
  adopt: AdoptPlan;
  /** Что получилось из карточки (сухой прогон с подробностями и запись): имя задачи или что поправить. */
  adopted: Map<number, { item: AdoptItem } | { problem: string }>;
  /** Что станет с чек-листами карточек (по id задачи) — в сухом прогоне с подробностями и при записи. */
  checklists: Map<string, ChecklistDiff>;
  ops: SyncOp[];
  errors: SyncError[];
  /** Сколько действий дошло до Kaiten. */
  done: number;
}

export function toCardView(card: Card): CardView {
  return {
    id: card.id,
    title: card.title ?? '',
    externalId: card.external_id === null || card.external_id === undefined ? null : String(card.external_id),
    parents: card.parents_ids ?? [],
    properties: card.properties ?? {},
    archived: card.archived === true,
    columnId: card.column_id,
    typeId: card.type_id,
    dueDate: card.due_date,
    columnChangedAt: card.column_changed_at ?? undefined,
    createdAt: card.created,
  };
}

/** Текст ошибки Kaiten для человека: `error_text`/`message` из ответа, иначе код. */
export function apiErrorText(error: unknown): string {
  if (error instanceof KaitenApiError) {
    try {
      const body: unknown = JSON.parse(error.body);
      if (body && typeof body === 'object') {
        for (const field of ['error_text', 'message', 'error']) {
          const value = (body as Record<string, unknown>)[field];
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
      }
    } catch {
      // Не JSON — ниже код ответа.
    }
    return error.status ? `Kaiten ответил ${error.status}` : 'Kaiten недоступен';
  }
  return error instanceof Error ? error.message : String(error);
}

function existingLists(card: Card): ExistingChecklist[] {
  return (card.checklists ?? []).map((l) => ({
    id: l.id,
    name: l.name ?? '',
    items: (l.items ?? []).map((i) => ({ id: i.id, text: i.text ?? '', checked: i.checked === true })),
  }));
}

async function applyChecklists(client: KaitenClient, cardId: number, diff: ChecklistDiff): Promise<void> {
  for (const [index, list] of diff.createLists.entries()) {
    const created = await client.createChecklist(cardId, list.name, index + 1);
    for (const [i, item] of list.items.entries()) await client.addChecklistItem(created.id, item, i + 1);
  }
  for (const add of diff.addItems) await client.addChecklistItem(add.listId, add.item, add.sortOrder);
  for (const set of diff.setChecked) await client.updateChecklistItem(cardId, set.listId, set.itemId, { checked: set.checked });
  for (const set of diff.setText) await client.updateChecklistItem(cardId, set.listId, set.itemId, { text: set.text });
}

function describe(action: SyncAction): string {
  const ref = refOf(action.task);
  if (action.kind === 'create') return `создать карточку для ${ref}`;
  if (action.kind === 'link') return `связать ${ref} с эпиком`;
  return `обновить карточку ${ref}`;
}

export interface RunInput extends Omit<PlanInput, 'cards'> {
  boardId: number;
  /** Почта → человек (`convert/people.json`): автор задачи из карточки. */
  people?: Readonly<Record<string, string>>;
  /** Только эти карточки переносить в задачи; при `only` без него — ни одной. */
  onlyCards?: ReadonlySet<number>;
  /** Дата операции `YYYY-MM-DD`; по умолчанию сегодня. */
  date?: string;
}

function fullOf(card: Card): FullCard {
  return {
    description: card.description ?? null,
    ownerEmail: card.owner?.email,
    ownerName: card.owner?.full_name,
    textFormat: card.text_format_type_id,
  };
}

export type RunMode = 'plan' | 'details' | 'apply';

/**
 * Прочитать доску и построить план; `details` — ещё прочитать обновляемые
 * карточки и посчитать чек-листы; `apply` — выполнить.
 */
export async function runKaitenSync(client: KaitenClient, input: RunInput, mode: RunMode): Promise<SyncRun> {
  const cards = (await client.listCards({ boardId: input.boardId })).map(toCardView);
  const plan = planKaitenSync({ ...input, cards });
  const adopt = planAdoption({ ...input, cards, onlyCards: input.onlyCards ?? (input.only ? new Set() : undefined) });
  const run: SyncRun = { plan, adopt, adopted: new Map(), checklists: new Map(), ops: [], errors: [], done: 0 };
  if (mode === 'plan') return run;
  const adoptCtx = { mapping: input.mapping, people: input.people ?? {}, date: input.date ?? localDate(new Date().toISOString()) };

  if (mode === 'details') {
    for (const candidate of adopt.candidates) run.adopted.set(candidate.card.id, adoptedTask(candidate, fullOf(await client.getCard(candidate.card.id)), adoptCtx));
    for (const action of plan.actions) {
      if (action.kind === 'update' && action.content) {
        const card = await client.getCard(action.cardId);
        run.checklists.set(action.task.fm.id, diffChecklists(action.content.checklists, existingLists(card), action.firstDelivery));
      } else if (action.kind === 'create') {
        run.checklists.set(action.task.fm.id, diffChecklists(action.content.checklists, [], true));
      }
    }
    return run;
  }

  // Карточки без файла: комментарий → пометка → файл (порядок и обрывы — в kaiten-adopt.ts).
  const adoptItems: AdoptItem[] = [];
  for (const candidate of adopt.candidates) {
    try {
      const card = await client.getCard(candidate.card.id);
      const built = adoptedTask(candidate, fullOf(card), adoptCtx);
      run.adopted.set(candidate.card.id, built);
      if ('problem' in built) {
        run.errors.push({ what: `перенести карточку ${label(candidate.card)} в задачи`, message: built.problem });
        continue;
      }
      if (!candidate.recovery) {
        const description = card.description?.trim();
        if (description) await client.addComment(candidate.card.id, originalComment(description));
        await client.updateCard(candidate.card.id, { external_id: candidate.id });
      }
      adoptItems.push(built.item);
      run.done += 1;
    } catch (error) {
      run.errors.push({ what: `перенести карточку ${label(candidate.card)} в задачи`, message: apiErrorText(error) });
    }
  }
  if (adoptItems.length > 0) run.ops.push({ op: { kind: 'adopt', items: adoptItems }, what: `задачи из карточек Kaiten (${adoptItems.length})` });

  // Поля Kaiten в файлы — они не зависят от записи в Kaiten.
  if (plan.mirror.length > 0) run.ops.push({ op: { kind: 'mirror', items: plan.mirror }, what: `поля из Kaiten (${plan.mirror.length})` });

  const synced: SyncedItem[] = [];
  const syncedNames: string[] = [];
  // Карточки, созданные в этом проходе, — для связи задач с только что созданным эпиком.
  const created = new Map<string, number>();
  for (const action of plan.actions) {
    try {
      if (action.kind === 'create') {
        const existing = await client.findCardByExternalId(action.fields.external_id, input.boardId);
        const card =
          existing ??
          (await client.createCard({
            board_id: input.boardId,
            title: action.fields.title,
            external_id: action.fields.external_id,
            column_id: action.fields.column_id,
            lane_id: action.fields.lane_id,
            type_id: action.fields.type_id,
            properties: action.fields.properties,
            description: action.content.description,
          }));
        if (existing) await client.updateCard(card.id, { description: action.content.description });
        const lists = existing ? existingLists(await client.getCard(card.id)) : [];
        const diff = diffChecklists(action.content.checklists, lists, true);
        run.checklists.set(action.task.fm.id, diff);
        await applyChecklists(client, card.id, diff);
        created.set(action.task.fm.id, card.id);
        const parentId = parentCardId(action, input.tasks, created);
        if (parentId !== null) await client.addChild(parentId, card.id);
        synced.push({ id: action.task.fm.id, contentHash: action.contentHash, tracker: String(card.id), team: action.fields.team });
        syncedNames.push(action.task.slug);
      } else if (action.kind === 'update') {
        if (action.patch.title !== undefined || action.patch.properties !== undefined) await client.updateCard(action.cardId, action.patch);
        if (action.content) {
          await client.updateCard(action.cardId, { description: action.content.description });
          // Чек-листы — только из GET: в списке карточек их нет.
          const diff = diffChecklists(action.content.checklists, existingLists(await client.getCard(action.cardId)), action.firstDelivery);
          run.checklists.set(action.task.fm.id, diff);
          if (!emptyDiff(diff)) await applyChecklists(client, action.cardId, diff);
          synced.push({ id: action.task.fm.id, contentHash: action.contentHash });
          syncedNames.push(refOf(action.task));
        }
      } else {
        await client.addChild(action.parentId, action.childId);
      }
      run.done += 1;
    } catch (error) {
      run.errors.push({ what: describe(action), message: apiErrorText(error) });
    }
  }
  if (synced.length > 0) {
    const what = synced.length === 1 ? `карточка ${syncedNames[0]}` : `карточки Kaiten (${synced.length})`;
    run.ops.push({ op: { kind: 'synced', items: synced }, what });
  }
  return run;
}

function parentCardId(action: Extract<SyncAction, { kind: 'create' }>, tasks: readonly TaskRecord[], created: ReadonlyMap<string, number>): number | null {
  if (!action.parentRef) return null;
  const fromThisRun = created.get(action.parentRef);
  if (fromThisRun !== undefined) return fromThisRun;
  const epic = tasks.find((t) => t.fm.id === action.parentRef);
  return epic?.fm.tracker !== undefined && /^\d+$/.test(epic.fm.tracker) ? Number(epic.fm.tracker) : null;
}

function checklistLine(diff: ChecklistDiff | undefined): string {
  if (!diff) return '';
  const parts: string[] = [];
  const created = diff.createLists.reduce((n, l) => n + l.items.length, 0);
  if (diff.createLists.length > 0) parts.push(`новых чек-листов ${diff.createLists.length} (пунктов ${created})`);
  if (diff.addItems.length > 0) parts.push(`добавить пунктов ${diff.addItems.length}`);
  const ticks = diff.setChecked.filter((s) => s.checked).length;
  const unticks = diff.setChecked.length - ticks;
  if (ticks > 0) parts.push(`отметить ${ticks}`);
  if (unticks > 0) parts.push(`СНЯТЬ отметку ${unticks}`);
  if (diff.keptTicks.length > 0) parts.push(`отмечено в Kaiten, но не в файле — оставим ${diff.keptTicks.length}`);
  if (diff.setText.length > 0) parts.push(`обновить текст пунктов ${diff.setText.length}`);
  return parts.length > 0 ? `; чек-листы: ${parts.join(', ')}` : '; чек-листы без изменений';
}

/** План для владельца: что будет сделано и чего не будет. */
export function formatPlan(run: Pick<SyncRun, 'plan' | 'checklists'> & Partial<Pick<SyncRun, 'adopt' | 'adopted'>>): string[] {
  const { plan } = run;
  const out: string[] = [];
  const count = (kind: SyncAction['kind']): number => plan.actions.filter((a) => a.kind === kind).length;
  const adopt = run.adopt?.candidates ?? [];
  out.push(
    `Создать карточек: ${count('create')}, обновить: ${count('update')}, связать с эпиком: ${count('link')}; из Kaiten в задачи: ${plan.mirror.length}; новых задач из карточек: ${adopt.length}`,
  );
  for (const c of adopt) {
    const built = run.adopted?.get(c.card.id);
    const result = built === undefined ? '' : 'problem' in built ? ` — не перенести: ${built.problem}` : ` → ${built.item.slug}`;
    out.push(`  → файл: ${label(c.card)} (${c.type}, ${c.status}${c.epic ? `, эпик ${c.epic}` : ''})${c.recovery ? ' [повтор после обрыва]' : ''}${result}`);
  }
  for (const a of plan.actions) {
    const lists = checklistLine(run.checklists.get(a.task.fm.id));
    if (a.kind === 'create') out.push(`  + ${a.task.slug}: «${a.task.fm.title}» (${a.task.fm.type}, ${a.task.fm.status})${lists}`);
    else if (a.kind === 'update') {
      const what = [a.patch.title !== undefined ? 'заголовок' : '', a.patch.properties ? `поля ${Object.keys(a.patch.properties).join(', ')}` : '', a.content ? 'описание' : '']
        .filter(Boolean)
        .join(', ');
      out.push(`  ~ ${refOf(a.task)} (${a.task.slug}): ${what}${a.content ? lists : ''}${a.firstDelivery && a.content ? ' [первая доставка]' : ''}`);
    } else out.push(`  → ${refOf(a.task)} в эпик ${a.parentId}`);
  }
  for (const m of plan.mirror) {
    const fields = [
      m.status !== undefined ? `статус → ${m.status}` : '',
      m.type !== undefined ? `тип → ${m.type}` : '',
      m.priority !== undefined ? `приоритет → ${m.priority ?? 'нет'}` : '',
      m.team !== undefined ? `команда → ${m.team ?? 'нет'}` : '',
      m.due !== undefined ? `срок → ${m.due ?? 'нет'}` : '',
    ].filter(Boolean);
    out.push(`  ← ${plan.names[m.id] ?? m.id}: ${fields.join(', ')}`);
  }
  const r = plan.report;
  if (run.adopt && run.adopt.problems.length > 0) out.push(`Карточки без задачи, которые не перенести — поправьте в Kaiten: ${run.adopt.problems.join('; ')}`);
  if (run.adopt && run.adopt.foreign.length > 0) out.push(`Карточки с чужим внешним ключом — не трогаем: ${run.adopt.foreign.join('; ')}`);
  if (r.unknownColumns.length > 0) out.push(`Карточка в колонке не из конфига — статус не переносим: ${r.unknownColumns.join(', ')}`);
  if (r.firstLoadCandidates > 0) out.push(`Перенесённых открытых задач без карточки: ${r.firstLoadCandidates} — только первой заливкой (--first-load).`);
  if (r.missingCards.length > 0) out.push(`Карточки нет на доске — не создаём заново: ${r.missingCards.join(', ')}`);
  if (r.archivedCards.length > 0) out.push(`Карточка в архиве Kaiten — не трогаем: ${r.archivedCards.join(', ')}`);
  if (r.unknownTrackers.length > 0) out.push(`Ключ без номера карточки — пропуск: ${r.unknownTrackers.join(', ')}`);
  if (r.ignored.length > 0) out.push(`Не трогаем по списку владельца: ${r.ignored.join(', ')}`);
  if (r.closedWithoutCard.length > 0) out.push(`Закрытые без карточки — не создаём: ${r.closedWithoutCard.length}`);
  return out;
}
