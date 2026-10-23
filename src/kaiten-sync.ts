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
 *   · чек-листы и файлы каждый раз сравниваются с тем, что в карточке сейчас:
 *     повтор доделывает недоделанное. Файл заменяется так: сначала новый,
 *     потом удаление старого; два файла с одним именем после обрыва — лишний
 *     удалит следующий проход (остаётся тот, что совпал с задачей).
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
 * Проверено живьём 29.09 на тестовых карточках: создание (в том числе сразу
 * в «Сделано»/«Отменено» — ограничения доски создание не запрещают), связь с
 * эпиком, пункты чек-листов, комментарий, запись `external_id`, перенос
 * карточек из интерфейса и перерисовка их описания. Новую конструкцию API —
 * сначала на одной тестовой карточке (`--only`) с перечитыванием.
 */

import { adoptedTask, label, planAdoption, type AdoptPlan, type FullCard } from './core/kaiten-adopt.js';
import {
  diffChecklists,
  localDate,
  emptyDiff,
  planKaitenSync,
  RETIRED_FILES,
  type CardView,
  type ChecklistDiff,
  type ExistingChecklist,
  type PlanInput,
  type SyncAction,
  type SyncPlan,
  type TaskFile,
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
  adopted: Map<number, ReturnType<typeof adoptedTask>>;
  /** Что станет с чек-листами карточек (по id задачи) — в сухом прогоне с подробностями и при записи. */
  checklists: Map<string, ChecklistDiff>;
  /** Что станет с файлами карточек (по id задачи) — там же. */
  files: Map<string, FilesDiff>;
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
    // Срок без времени — полночь UTC: берём дату как есть, иначе западнее UTC он съехал бы на день назад.
    dueDate: card.due_date && card.due_date_time_present !== true ? card.due_date.slice(0, 10) : card.due_date,
    columnChangedAt: card.column_changed_at ?? undefined,
    createdAt: card.created,
    laneId: card.lane_id,
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
    items: (l.items ?? []).map((i) => ({ id: i.id, text: i.text ?? '', checked: i.checked === true, sortOrder: i.sort_order })),
  }));
}

/** Сначала удаления — потом новое и правки: в карточке не бывает старого и нового пункта рядом. */
async function applyChecklists(client: KaitenClient, cardId: number, diff: ChecklistDiff): Promise<void> {
  for (const list of diff.deleteLists) await client.deleteChecklist(cardId, list.listId);
  for (const item of diff.deleteItems) await client.deleteChecklistItem(cardId, item.listId, item.itemId);
  for (const [index, list] of diff.createLists.entries()) {
    const created = await client.createChecklist(cardId, list.name, index + 1);
    for (const [i, item] of list.items.entries()) await client.addChecklistItem(created.id, item, i + 1);
  }
  for (const add of diff.addItems) await client.addChecklistItem(add.listId, add.item, add.sortOrder);
  for (const { listId, itemId, ...patch } of diff.updateItems) await client.updateChecklistItem(cardId, listId, itemId, patch);
}

/**
 * Файлы карточки против файлов задачи. Наш — файл с тем же именем и UUID
 * (старые файлы с числовым id мы не загружали — не трогаем); остальные
 * файлы карточки — людей. Совпадение содержимого: при равном размере файл
 * скачивается и сравнивается, иначе он заменяется.
 */
export interface FilesDiff {
  upload: TaskFile[];
  replace: Array<{ file: TaskFile; old: string[] }>;
  /** Повторы нашего файла (обрыв между загрузкой и удалением) — лишние. */
  duplicates: Array<{ name: string; id: string }>;
  /** Файлы, которые синхронизация больше не прикладывает (журнал до 20.10.2026), — убрать. */
  retired: Array<{ name: string; id: string }>;
}

function emptyFiles(diff: FilesDiff): boolean {
  return diff.upload.length === 0 && diff.replace.length === 0 && diff.duplicates.length === 0 && diff.retired.length === 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function diffFiles(client: KaitenClient, card: Card, wanted: readonly TaskFile[], content: (file: TaskFile) => Uint8Array): Promise<FilesDiff> {
  const diff: FilesDiff = { upload: [], replace: [], duplicates: [], retired: [] };
  for (const f of card.files ?? []) if (typeof f.id === 'string' && RETIRED_FILES.includes(f.name)) diff.retired.push({ name: f.name, id: f.id });
  if ((wanted.length > 0 || diff.retired.length > 0) && !card.uid) throw new KaitenApiError('Kaiten не отдал UUID карточки — файлы не загрузить', 0, '');
  const uid = card.uid ?? '';
  for (const file of wanted) {
    const ours = (card.files ?? []).filter((f): f is typeof f & { id: string } => typeof f.id === 'string' && f.name === file.name);
    if (ours.length === 0) {
      diff.upload.push(file);
      continue;
    }
    let keep: string | undefined;
    for (const f of ours) {
      if (Number(f.size) !== file.size) continue;
      if (sameBytes(await client.cardFileContent(uid, f.id), content(file))) {
        keep = f.id;
        break;
      }
    }
    if (keep === undefined) diff.replace.push({ file, old: ours.map((f) => f.id) });
    else for (const f of ours) if (f.id !== keep) diff.duplicates.push({ name: f.name, id: f.id });
  }
  return diff;
}

/** Загрузить файл под его именем; не вышло назвать (путь в имени) — убрать загруженный: безымянный ничей. */
async function uploadAs(client: KaitenClient, uid: string, file: TaskFile, content: Uint8Array): Promise<void> {
  const uploaded = await client.uploadCardFile(uid, file.name, content);
  if (uploaded.name === file.name || typeof uploaded.id !== 'string') return;
  try {
    await client.renameCardFile(uid, uploaded.id, file.name);
  } catch (error) {
    await client.deleteCardFile(uid, uploaded.id);
    throw error;
  }
}

async function applyFiles(client: KaitenClient, card: Card, diff: FilesDiff, content: (file: TaskFile) => Uint8Array): Promise<void> {
  const uid = card.uid ?? '';
  for (const file of diff.upload) await uploadAs(client, uid, file, content(file));
  for (const { file, old } of diff.replace) {
    await uploadAs(client, uid, file, content(file));
    for (const id of old) await client.deleteCardFile(uid, id);
  }
  for (const { id } of diff.duplicates) await client.deleteCardFile(uid, id);
  for (const { id } of diff.retired) await client.deleteCardFile(uid, id);
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
  /** Содержимое вложения по git-объекту (`attachments` в плане). */
  readFile?: (sha: string) => Uint8Array;
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
  const run: SyncRun = { plan, adopt, adopted: new Map(), checklists: new Map(), files: new Map(), ops: [], errors: [], done: 0 };
  if (mode === 'plan') return run;
  const adoptCtx = { mapping: input.mapping, people: input.people ?? {}, date: input.date ?? localDate(new Date().toISOString()) };
  const content = (file: TaskFile): Uint8Array => {
    if (file.text !== undefined) return new TextEncoder().encode(file.text);
    if (!input.readFile) throw new Error(`нет содержимого вложения ${file.name}`);
    return input.readFile(file.sha);
  };

  if (mode === 'details') {
    for (const candidate of adopt.candidates) run.adopted.set(candidate.card.id, adoptedTask(candidate, fullOf(await client.getCard(candidate.card.id)), adoptCtx));
    for (const action of plan.actions) {
      try {
        if (action.kind === 'update' && (action.content || action.files)) {
          const card = await client.getCard(action.cardId);
          if (action.content) run.checklists.set(action.task.fm.id, diffChecklists(action.content.checklists, existingLists(card), action.firstDelivery));
          if (action.files) run.files.set(action.task.fm.id, await diffFiles(client, card, action.files.wanted, content));
        } else if (action.kind === 'create') {
          run.checklists.set(action.task.fm.id, diffChecklists(action.content.checklists, [], true));
          if (action.files) run.files.set(action.task.fm.id, { upload: action.files.wanted, replace: [], duplicates: [], retired: [] });
        }
      } catch (error) {
        run.errors.push({ what: describe(action), message: apiErrorText(error) });
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
      // Пометка появилась после чтения доски — карточку переносит другой разработчик: без второго комментария.
      if (!candidate.recovery && (card.external_id === null || card.external_id === undefined)) {
        if (built.comment !== null) await client.addComment(candidate.card.id, built.comment);
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
        if (action.files && action.files.wanted.length > 0) {
          // Файлов в ответе создания и в списке нет — только в GET.
          const full = await client.getCard(card.id);
          const files = await diffFiles(client, full, action.files.wanted, content);
          run.files.set(action.task.fm.id, files);
          await applyFiles(client, full, files, content);
        }
        synced.push({ id: action.task.fm.id, contentHash: action.contentHash, filesHash: action.files?.hash, tracker: String(card.id), team: action.fields.team });
        syncedNames.push(action.task.slug);
      } else if (action.kind === 'update') {
        if (action.patch.title !== undefined || action.patch.properties !== undefined || action.patch.lane_id !== undefined) await client.updateCard(action.cardId, action.patch);
        // Описание, чек-листы и файлы — только из GET: в списке карточек их нет.
        const card = action.content || action.files ? await client.getCard(action.cardId) : null;
        if (card && action.content) {
          // Совпавшее описание не переписываем: повторная доставка (`--resend`) без лишних записей.
          if (card.description !== action.content.description) await client.updateCard(action.cardId, { description: action.content.description });
          const diff = diffChecklists(action.content.checklists, existingLists(card), action.firstDelivery);
          run.checklists.set(action.task.fm.id, diff);
          if (!emptyDiff(diff)) await applyChecklists(client, action.cardId, diff);
        }
        if (card && action.files) {
          const files = await diffFiles(client, card, action.files.wanted, content);
          run.files.set(action.task.fm.id, files);
          if (!emptyFiles(files)) await applyFiles(client, card, files, content);
        }
        const contentHash = action.content ? action.contentHash : (action.task.fm.content_hash ?? action.contentHash);
        const filesHash = action.files?.hash;
        if (contentHash !== action.task.fm.content_hash || (filesHash !== undefined && filesHash !== action.task.fm.files_hash)) {
          synced.push({ id: action.task.fm.id, contentHash, filesHash });
          syncedNames.push(refOf(action.task));
        }
        // Архив — последним: описание и файлы уже доставлены, отметка о доставке записана.
        if (action.archive) await client.updateCard(action.cardId, { condition: 2 });
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

/** Что удаляется — словами, а не числом: владелец решает по сухому прогону. */
function quoted(texts: readonly string[]): string {
  const shown = texts.slice(0, 5).map((t) => `«${t.length > 60 ? `${t.slice(0, 57)}…` : t}»`);
  return texts.length > shown.length ? `${shown.join(', ')} и ещё ${texts.length - shown.length}` : shown.join(', ');
}

function checklistLine(diff: ChecklistDiff | undefined): string {
  if (!diff) return '';
  const parts: string[] = [];
  const created = diff.createLists.reduce((n, l) => n + l.items.length, 0);
  if (diff.createLists.length > 0) parts.push(`новых чек-листов ${diff.createLists.length} (пунктов ${created})`);
  if (diff.addItems.length > 0) parts.push(`добавить пунктов ${diff.addItems.length}`);
  if (diff.deleteItems.length > 0) parts.push(`УДАЛИТЬ пунктов ${diff.deleteItems.length}: ${quoted(diff.deleteItems.map((i) => i.text))}`);
  if (diff.deleteLists.length > 0) parts.push(`УДАЛИТЬ чек-листов ${diff.deleteLists.length}: ${quoted(diff.deleteLists.map((l) => l.name))}`);
  const ticks = diff.updateItems.filter((u) => u.checked === true).length;
  const unticks = diff.updateItems.filter((u) => u.checked === false).length;
  if (ticks > 0) parts.push(`отметить ${ticks}`);
  if (unticks > 0) parts.push(`СНЯТЬ отметку ${unticks}`);
  if (diff.keptTicks.length > 0) parts.push(`отмечено в Kaiten, но не в файле — оставим ${diff.keptTicks.length}`);
  if (diff.keptItems.length > 0) parts.push(`пунктов нет в файле — оставим ${diff.keptItems.length}: ${quoted(diff.keptItems)}`);
  if (diff.keptLists.length > 0) parts.push(`чек-листов нет в файле — оставим ${diff.keptLists.length}: ${quoted(diff.keptLists)}`);
  const texts = diff.updateItems.filter((u) => u.text !== undefined).length;
  if (texts > 0) parts.push(`обновить текст пунктов ${texts}`);
  const moves = diff.updateItems.filter((u) => u.sortOrder !== undefined && u.text === undefined && u.checked === undefined).length;
  if (moves > 0) parts.push(`переставить пунктов ${moves}`);
  return parts.length > 0 ? `; чек-листы: ${parts.join(', ')}` : '; чек-листы без изменений';
}

function filesLine(diff: FilesDiff | undefined): string {
  if (!diff) return '';
  const parts: string[] = [];
  if (diff.upload.length > 0) parts.push(`загрузить ${diff.upload.length}: ${quoted(diff.upload.map((f) => f.name))}`);
  if (diff.replace.length > 0) parts.push(`заменить ${diff.replace.length}: ${quoted(diff.replace.map((r) => r.file.name))}`);
  if (diff.duplicates.length > 0) parts.push(`убрать повторов ${diff.duplicates.length}: ${quoted(diff.duplicates.map((d) => d.name))}`);
  if (diff.retired.length > 0) parts.push(`убрать прежний журнал-файл: ${quoted(diff.retired.map((d) => d.name))}`);
  return parts.length > 0 ? `; файлы: ${parts.join(', ')}` : '; файлы без изменений';
}

/** План для владельца: что будет сделано и чего не будет. */
export function formatPlan(run: Pick<SyncRun, 'plan' | 'checklists'> & Partial<Pick<SyncRun, 'adopt' | 'adopted' | 'files'>>): string[] {
  const { plan } = run;
  const out: string[] = [];
  const count = (kind: SyncAction['kind']): number => plan.actions.filter((a) => a.kind === kind).length;
  const adopt = run.adopt?.candidates ?? [];
  out.push(
    `Создать карточек: ${count('create')}, обновить: ${count('update')}, связать с эпиком: ${count('link')}; из Kaiten в задачи: ${plan.mirror.length}; новых задач из карточек: ${adopt.length}`,
  );
  const junior = plan.junior;
  if (junior && junior.yes + junior.no + junior.cleared > 0) {
    out.push(`«Можно младшему»: «Да» — ${junior.yes}, «Нет» — ${junior.no}, очистить — ${junior.cleared}`);
  }
  for (const c of adopt) {
    const built = run.adopted?.get(c.card.id);
    const result = built === undefined ? '' : 'problem' in built ? ` — не перенести: ${built.problem}` : ` → ${built.item.slug}`;
    out.push(`  → файл: ${label(c.card)} (${c.type}, ${c.status}${c.epic ? `, эпик ${c.epic}` : ''})${c.recovery ? ' [повтор после обрыва]' : ''}${result}`);
  }
  for (const a of plan.actions) {
    const lists = checklistLine(run.checklists.get(a.task.fm.id));
    const files = filesLine(run.files?.get(a.task.fm.id));
    if (a.kind === 'create') out.push(`  + ${a.task.slug}: «${a.task.fm.title}» (${a.task.fm.type}, ${a.task.fm.status})${lists}${files}`);
    else if (a.kind === 'update') {
      const lane = a.patch.lane_id === undefined ? '' : 'дорожка';
      const what = [
        a.patch.title !== undefined ? 'заголовок' : '',
        a.patch.properties ? `поля ${Object.keys(a.patch.properties).join(', ')}` : '',
        lane,
        a.content ? 'описание' : '',
        a.files ? 'файлы' : '',
        a.archive ? 'в архив Kaiten' : '',
      ]
        .filter(Boolean)
        .join(', ');
      out.push(`  ~ ${refOf(a.task)} (${a.task.slug}): ${what}${a.content ? lists : ''}${a.files ? files : ''}${a.firstDelivery && a.content ? ' [первая доставка]' : ''}`);
    } else out.push(`  → ${refOf(a.task)} в эпик ${a.parentId}`);
  }
  for (const m of plan.mirror) {
    const fields = [
      m.status !== undefined ? `статус → ${m.status}` : '',
      m.type !== undefined ? `тип → ${m.type}` : '',
      m.priority !== undefined ? `приоритет → ${m.priority ?? 'нет'}` : '',
      m.team !== undefined ? `команда → ${m.team ?? 'нет'}` : '',
      m.due !== undefined ? `срок → ${m.due ?? 'нет'}` : '',
      m.assessment !== undefined ? `оценка → ${m.assessment ?? 'нет'}` : '',
    ].filter(Boolean);
    out.push(`  ← ${plan.names[m.id] ?? m.id}: ${fields.join(', ')}`);
  }
  const r = plan.report;
  if (run.adopt && run.adopt.problems.length > 0) out.push(`Карточки без задачи, которые не перенести — поправьте в Kaiten: ${run.adopt.problems.join('; ')}`);
  if (run.adopt && run.adopt.foreign.length > 0) out.push(`Карточки с чужим внешним ключом — не трогаем: ${run.adopt.foreign.join('; ')}`);
  if (r.unknownColumns.length > 0) out.push(`Карточка в колонке не из конфига — статус не переносим: ${r.unknownColumns.join(', ')}`);
  if (r.withoutVisual.length > 0) out.push(`На ревью или закрыты без ответа «Было / Стало» (перенесли в Kaiten руками): ${r.withoutVisual.join(', ')}`);
  if (r.firstLoadCandidates > 0) out.push(`Перенесённых открытых задач без карточки: ${r.firstLoadCandidates} — только первой заливкой (--first-load).`);
  if (r.missingCards.length > 0) out.push(`Карточки нет на доске — не создаём заново: ${r.missingCards.join(', ')}`);
  if (r.archivedCards.length > 0) out.push(`Карточка в архиве Kaiten — не трогаем: ${r.archivedCards.join(', ')}`);
  if (r.unknownTrackers.length > 0) out.push(`Ключ без номера карточки — пропуск: ${r.unknownTrackers.join(', ')}`);
  if (r.ignored.length > 0) out.push(`Не трогаем по списку владельца: ${r.ignored.join(', ')}`);
  if (r.closedWithoutCard.length > 0) out.push(`Закрытые без карточки — не создаём: ${r.closedWithoutCard.length}`);
  return out;
}
