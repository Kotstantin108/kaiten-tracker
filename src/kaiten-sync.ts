/**
 * Выполнение плана синхронизации с Kaiten (`core/kaiten-sync-plan.ts`).
 *
 * Возобновляемо: всё, что дошло до Kaiten, возвращается операциями `synced`
 * (ключ карточки, доставленный хеш) — их записывают в журнал хранилища и
 * отправляют общим, как любую запись. Обрыв посередине безопасен:
 *   · создание сначала ищет карточку по `external_id` = id задачи — повтор
 *     найдёт созданную, а не сделает вторую;
 *   · обновление идемпотентно: те же поля и описание ещё раз;
 *   · пункты чек-листов только добавляются и отмечаются, не удаляются.
 *
 * Ошибка одной задачи не останавливает остальные: она — в `errors`, словами
 * задачи. Токен в сообщения не попадает: клиент его не печатает, а текст
 * ошибки берётся из ответа Kaiten (для ограничений доски это `error_text`,
 * который написал владелец).
 *
 * НЕ ПРОВЕРЕНО ЖИВЬЁМ (по документации): связь эпик → задача (`addChild`),
 * отметка пункта (`updateChecklistItem`). Первый живой вызов — на тестовой
 * карточке с перечитыванием сохранённого.
 */

import type { Checklist } from './checklists.js';
import { planKaitenSync, type CardView, type PlanInput, type RenderedContent, type SyncAction, type SyncPlan } from './core/kaiten-sync-plan.js';
import type { Op } from './core/task-ops.js';
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

async function pushChecklists(client: KaitenClient, cardId: number, wanted: readonly Checklist[], existing: Card['checklists']): Promise<void> {
  const lists = existing ?? [];
  for (const [index, list] of wanted.entries()) {
    const found = lists.find((l) => l.name === list.name);
    if (!found) {
      const created = await client.createChecklist(cardId, list.name, index + 1);
      for (const [i, item] of list.items.entries()) await client.addChecklistItem(created.id, item, i + 1);
      continue;
    }
    const items = found.items ?? [];
    for (const [i, item] of list.items.entries()) {
      const same = items.find((x) => (x.text ?? '').trim() === item.text.trim());
      if (!same) await client.addChecklistItem(found.id, item, items.length + i + 1);
      else if (same.id !== undefined && same.checked !== item.checked) await client.updateChecklistItem(cardId, found.id, same.id, { checked: item.checked });
    }
  }
}

async function pushContent(client: KaitenClient, cardId: number, content: RenderedContent): Promise<void> {
  await client.updateCard(cardId, { description: content.description });
  // Чек-листы — только из GET: в списке карточек их нет.
  const card = await client.getCard(cardId);
  await pushChecklists(client, cardId, content.checklists, card.checklists);
}

function describe(action: SyncAction): string {
  const ref = refOf(action.task);
  if (action.kind === 'create') return `создать карточку для ${ref}`;
  if (action.kind === 'link') return `связать ${ref} с эпиком`;
  return `обновить карточку ${ref}`;
}

export interface RunInput extends Omit<PlanInput, 'cards'> {
  boardId: number;
}

/** Прочитать доску, построить план и — с `apply` — выполнить его. */
export async function runKaitenSync(client: KaitenClient, input: RunInput, apply: boolean): Promise<SyncRun> {
  const cards = (await client.listCards({ boardId: input.boardId })).map(toCardView);
  const plan = planKaitenSync({ ...input, cards });
  const run: SyncRun = { plan, ops: [], errors: [], done: 0 };
  if (!apply) return run;

  // Карточки, созданные в этом проходе, — для связи задач с только что созданным эпиком.
  const createdByTaskId = new Map<string, number>();
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
        await pushChecklists(client, card.id, action.content.checklists, existing ? (await client.getCard(card.id)).checklists : []);
        createdByTaskId.set(action.task.fm.id, card.id);
        const parentId = parentCardId(action, input.tasks, createdByTaskId);
        if (parentId !== null) await client.addChild(parentId, card.id);
        run.ops.push({ op: { kind: 'synced', id: action.task.fm.id, contentHash: action.contentHash, tracker: String(card.id) }, what: `карточка для ${refOf(action.task)}` });
      } else if (action.kind === 'update') {
        if (action.patch.title !== undefined || action.patch.properties !== undefined) await client.updateCard(action.cardId, action.patch);
        if (action.content) {
          await pushContent(client, action.cardId, action.content);
          run.ops.push({ op: { kind: 'synced', id: action.task.fm.id, contentHash: action.contentHash }, what: `карточка ${refOf(action.task)}` });
        }
      } else {
        await client.addChild(action.parentId, action.childId);
      }
      run.done += 1;
    } catch (error) {
      run.errors.push({ what: describe(action), message: apiErrorText(error) });
    }
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

/** Сухой прогон для владельца: что будет сделано и чего не будет. */
export function formatPlan(plan: SyncPlan): string[] {
  const out: string[] = [];
  const count = (kind: SyncAction['kind']): number => plan.actions.filter((a) => a.kind === kind).length;
  out.push(`Создать карточек: ${count('create')}, обновить: ${count('update')}, связать с эпиком: ${count('link')}`);
  for (const a of plan.actions) {
    if (a.kind === 'create') out.push(`  + ${a.task.slug}: «${a.task.fm.title}» (${a.task.fm.type}, ${a.task.fm.status}, чек-листов ${a.content.checklists.length})`);
    else if (a.kind === 'update') {
      const what = [a.patch.title !== undefined ? 'заголовок' : '', a.patch.properties ? `поля ${Object.keys(a.patch.properties).join(', ')}` : '', a.content ? 'описание и чек-листы' : '']
        .filter(Boolean)
        .join(', ');
      out.push(`  ~ ${refOf(a.task)} (${a.task.slug}): ${what}`);
    } else out.push(`  → ${refOf(a.task)} в эпик ${a.parentId}`);
  }
  const r = plan.report;
  if (r.firstLoadCandidates > 0) out.push(`Перенесённых открытых задач без карточки: ${r.firstLoadCandidates} — только первой заливкой (--first-load).`);
  if (r.missingCards.length > 0) out.push(`Карточки нет на доске (архив или удалена) — не трогаем: ${r.missingCards.join(', ')}`);
  if (r.unknownTrackers.length > 0) out.push(`Ключ без номера карточки — пропуск: ${r.unknownTrackers.join(', ')}`);
  if (r.ignored.length > 0) out.push(`Не трогаем по списку владельца: ${r.ignored.join(', ')}`);
  if (r.closedWithoutCard.length > 0) out.push(`Закрытые без карточки — не создаём: ${r.closedWithoutCard.join(', ')}`);
  return out;
}

