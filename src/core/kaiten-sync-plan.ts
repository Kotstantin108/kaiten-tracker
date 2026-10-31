/**
 * План синхронизации задач с Kaiten — чистая часть: файл → Kaiten (этап 2a)
 * и Kaiten → файл (этап 2b, `mirrorFromCard`).
 *
 * ЧТО ПИШЕТ KAITEN В ФАЙЛ (решение 9, Q30): статус (колонка), тип,
 * приоритет, команда, срок, «Оценка» — всегда, Kaiten здесь владелец. Исполнителя пока
 * нет: список карточек не отдаёт участников, а читать каждую карточку на
 * каждом проходе дорого (`planning.assignee` — этап с кешем по `version`).
 *
 * ЧТО ПИШЕТ ФАЙЛ В КАРТОЧКУ (Q1, решение 9): заголовок, «Суть», «Репозиторий»,
 * описание (первая строка — пометка Q41), чек-листы «Агент · <раздел>»
 * (Q43), связь с эпиком. Колонку, тип, приоритет и команду — только при
 * создании карточки: дальше ими владеет Kaiten.
 *
 * КОГДА ОБНОВЛЯТЬ. `content_hash` в файле — «это карточка уже получила»; его
 * ставит только синхронизация (операция `synced`). Хеш — не только файла:
 * описание зависит ещё от версии отрисовки, адреса репозитория задач и
 * текущих путей задач, на которые ссылается тело (`deliveredHash`). Появился
 * адрес репозитория или поменялся рендер — пилотные карточки перерисуются.
 * Не совпало (или хеша нет, как у перенесённых задач) — описание и чек-листы
 * нужно отправить (Q32).
 *
 * ЧЕК-ЛИСТЫ (`diffChecklists`). Владелец чек-листов «Агент · …» — файл
 * (Q43): одна доставка приводит их к файлу — лишние пункты и чек-листы
 * удаляются, изменённый пункт заменяется на месте, порядок — как в файле.
 * Пункт карточки сопоставляется с пунктом файла по тексту без ссылок и
 * разметки — перезапись ссылок не плодит дублей. Первая доставка (у пилотных
 * карточек галочки ставили в Kaiten, по старому правилу) ничего не удаляет и
 * галочек Kaiten не снимает: это в отчёте. Заголовок, «Суть» и «Репозиторий» видны в
 * списке карточек и сравниваются напрямую: правка их в интерфейсе Kaiten
 * возвращается к файлу (владелец — файл).
 *
 * ФАЙЛЫ КАРТОЧКИ (`taskFiles`). Вложения задачи лежат в карточке файлами —
 * человек открывает их без командной строки. Владелец файла с тем же
 * именем — репозиторий; файлы с другими именами — людей. Журнал — не файлом,
 * а ссылкой на GitHub в описании (`journalUrl`, владелец 20.10.2026): файл
 * перезаливался на каждую запись. Прежний файл журнала (`RETIRED_FILES`)
 * доставка убирает. Что карточка уже получила — `files_hash`, отдельно от
 * `content_hash`. Задаче без `files_hash` (появилась до файлов) файлы
 * доставляет только `--resend` скрипта владельца — так массовая загрузка
 * проходит через сухой прогон; новой карточке `files_hash` ставится сразу.
 *
 * КОГДА СОЗДАВАТЬ. Сама — только задачи, рождённые в CLI (`created_via` есть;
 * у перенесённых его нет по решению владельца) и ещё открытые. Перенесённые
 * задачи без карточки — «первая заливка», она идёт только скриптом владельца
 * с `--first-load` (AGENTS.md: массовые мутации — по «да» на план).
 *
 * КАРТОЧКИ БЕЗ ФАЙЛА (заведённые в интерфейсе Kaiten) — `kaiten-adopt.ts`.
 *
 * ЧЕГО НЕ ДЕЛАЕТ НИКОГДА: не трогает карточки из `ignoreCards`; не создаёт
 * заново карточку, которой нет в списке доски (архив или удалена) — это в
 * отчёт; не трогает чек-листы без префикса «Агент · » — их ведут люди.
 */

import { createHash } from 'node:crypto';

import { AGENT_PREFIX, extractChecklists, type Checklist, type ChecklistItem } from '../checklists.js';
import type { ConfigMapping, JuniorFields, VisualFields } from '../config.js';
import { juniorMissingText, juniorReadiness } from './junior.js';
import { visualApplies } from './visual.js';
import { JOURNAL_FILE, taskDate, type MirrorItem } from './task-ops.js';
import { ASSESS_VERDICTS, CLOSED_STATUSES, PRIORITIES, STATUSES, TASK_TYPES, type AssessVerdict, type Priority, type TaskStatus, type TaskType } from './schema.js';
import { contentHash } from './document.js';
import { epicOf, refOf, type TaskRecord } from './tasks-index.js';

/** Первая строка описания карточки (Q41). */
export const Q41_NOTICE = 'Текст обновляется автоматически из репозитория. Правки — комментарием.';

/** То, что синхронизация читает из списка карточек доски. */
export interface CardView {
  id: number;
  title: string;
  externalId: string | null;
  parents: number[];
  properties: Record<string, unknown>;
  /** Список доски отдаёт и архивные карточки (живьём 23.09). */
  archived: boolean;
  columnId?: number;
  typeId?: number;
  /** `due_date` карточки, ISO; `null` — срока нет. */
  dueDate?: string | null;
  /** Когда карточку перенесли в текущую колонку, ISO — месяц закрытия для архива. */
  columnChangedAt?: string;
  /** Когда карточку завели, ISO — дата создания задачи из карточки (этап 2c). */
  createdAt?: string;
  laneId?: number;
}

export interface RenderedContent {
  description: string;
  checklists: Checklist[];
}

/**
 * `git@github.com:org/repo.git` / `https://github.com/org/repo(.git)` →
 * `https://github.com/org/repo`; остальное (локальный путь) — `null`.
 */
export function repoWebBase(url: string | undefined): string | null {
  if (!url) return null;
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return https ? `https://github.com/${https[1]}/${https[2]}` : null;
}

/**
 * Ссылки на задачи (`/active/…`, `/archive/…`) и вложения (`/attachments/…`)
 * ведут в репозиторий задач. В карточке — постоянные ссылки на GitHub (путь
 * задачи — текущий: она могла уехать в архив); без адреса репозитория —
 * просто текст ссылки, а не битая относительная ссылка.
 */
export function linkify(text: string, all: readonly TaskRecord[], base: string | null): string {
  const pathOf = new Map(all.map((t) => [t.slug, t.path]));
  const target = (path: string): string => `${base}/blob/main/${path}`;
  return text
    .replace(/\[([^\]]*)\]\(\/(?:active|archive\/\d{4}-\d{2})\/([a-z0-9-]+)\.md(#[^)]*)?\)/g, (_all, label: string, slug: string, anchor: string | undefined) => {
      const path = pathOf.get(slug);
      return base && path ? `[${label}](${target(path)}${anchor ?? ''})` : label;
    })
    .replace(/\[([^\]]*)\]\(\/(attachments\/[^)\s]+)\)/g, (_all, label: string, path: string) => (base ? `[${label}](${target(path)})` : label));
}

/** Описание карточки и её чек-листы «Агент · …» из тела задачи. */
/**
 * Предел описания карточки: Kaiten отвечает 400 «Card.description should NOT
 * be longer than 32768 characters» (живьём 30.09, первая заливка). Запас — под
 * строку о продолжении.
 */
export const DESCRIPTION_LIMIT = 32_000;

/** Длинное описание — обрезать по абзацу и сказать, где полный текст. */
function fitDescription(text: string, task: TaskRecord, base: string | null): string {
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const cut = text.slice(0, DESCRIPTION_LIMIT);
  const paragraph = cut.lastIndexOf('\n\n');
  const kept = (paragraph > DESCRIPTION_LIMIT / 2 ? cut.slice(0, paragraph) : cut).trimEnd();
  const where = base ? `[в репозитории задач](${base}/blob/main/${task.path})` : `в репозитории задач (${task.path})`;
  return `${kept}\n\n…Текст задачи длиннее, чем помещается в карточку. Полностью — ${where}.\n`;
}

/**
 * Журнал задачи в карточке — ссылкой на GitHub, а не файлом: файл
 * перезаливался на каждую запись и копил в карточке мусор (владелец
 * 20.10.2026). Без журнала или без адреса репозитория задач — ссылки нет.
 */
export function journalUrl(task: TaskRecord, base: string | null): string | null {
  if (!base || !task.log?.trim()) return null;
  return `${base}/blob/main/${task.path.replace(/\.md$/, '.log.md')}`;
}

export function renderContent(task: TaskRecord, all: readonly TaskRecord[], base: string | null): RenderedContent {
  const { body, checklists } = extractChecklists(task.body.trim());
  const journal = journalUrl(task, base);
  const head = journal ? `${Q41_NOTICE}\n\nЖурнал работы — [в репозитории задач](${journal}).` : Q41_NOTICE;
  return {
    description: fitDescription(`${head}\n\n${linkify(body, all, base).trim()}\n`, task, base),
    checklists: checklists.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, text: linkify(i.text, all, base) })) })),
  };
}

/**
 * Версия отрисовки описания: поменяли рендер — поднять, и карточки
 * перерисуются. Старая версия `kaiten` перерисовала бы их обратно — вместе с
 * ней поднять и `SYNC_VERSION` (`core/sync-version.ts`).
 */
export const RENDER_VERSION = 1;

/**
 * «Что получила карточка»: содержимое файла + версия отрисовки + адрес
 * репозитория задач + текущие пути задач, на которые ссылается тело (задача
 * уехала в архив — ссылка в карточке должна смениться).
 */
export function deliveredHash(task: TaskRecord, all: readonly TaskRecord[], base: string | null): string {
  const linked = [...task.body.matchAll(/\]\(\/(?:active|archive\/\d{4}-\d{2})\/([a-z0-9-]+)\.md/g)].map((m) => m[1]);
  const paths = [...new Set(linked)].sort().map((slug) => all.find((x) => x.slug === slug)?.path ?? null);
  // Ссылка на журнал — только у задач с журналом: у остальных хеш прежний, и карточки не перерисовываются.
  const journal = journalUrl(task, base);
  const payload = JSON.stringify([contentHash(task.fm, task.body), RENDER_VERSION, base, paths, ...(journal ? [journal] : [])]);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
export interface ExistingChecklist {
  id: number;
  name: string;
  items: Array<{ id?: number; text: string; checked: boolean; sortOrder?: number }>;
}

/** Правка пункта одним PATCH: только поля, которые расходятся с файлом. */
export interface ItemUpdate {
  listId: number;
  itemId: number;
  text?: string;
  checked?: boolean;
  sortOrder?: number;
}

export interface ChecklistDiff {
  createLists: Checklist[];
  /** Чек-листы «Агент · …», раздела которых в файле нет (и дубли по имени). */
  deleteLists: Array<{ listId: number; name: string }>;
  addItems: Array<{ listId: number; item: ChecklistItem; sortOrder: number }>;
  updateItems: ItemUpdate[];
  deleteItems: Array<{ listId: number; itemId: number; text: string }>;
  /** Отмечено в Kaiten, не отмечено в файле — при первой доставке остаётся как есть. */
  keptTicks: string[];
  /** Пункты и чек-листы, которых нет в файле, — при первой доставке остаются как есть. */
  keptItems: string[];
  keptLists: string[];
}

function itemKey(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/**
 * Чек-листы карточки → как в файле, одним проходом. Владелец пунктов
 * «Агент · …» — файл (Q43), поэтому всё, чего в файле нет, удаляется: пункт,
 * чек-лист убранного или переименованного раздела, дубль чек-листа с тем же
 * именем. Чек-листы без префикса заводят люди — их не трогаем. Первая
 * доставка не удаляет, не снимает отметок и не переписывает непарные пункты:
 * в карточке может быть работа людей до правила «файл владеет» — это в отчёт.
 *
 * Сопоставление пункта: по тексту, затем без ссылок и разметки, затем по
 * месту — непарный пункт файла и непарный пункт карточки на одной позиции
 * считаются правкой текста (замена на месте, id пункта сохраняется). Порядок
 * — как в файле: `sort_order` пункта = его номер в файле.
 */
export function diffChecklists(wanted: readonly Checklist[], existing: readonly ExistingChecklist[], firstDelivery: boolean): ChecklistDiff {
  const diff: ChecklistDiff = { createLists: [], deleteLists: [], addItems: [], updateItems: [], deleteItems: [], keptTicks: [], keptItems: [], keptLists: [] };
  const usedLists = new Set<number>();
  for (const list of wanted) {
    const found = existing.find((l) => l.name === list.name && !usedLists.has(l.id));
    if (!found) {
      diff.createLists.push(list);
      continue;
    }
    usedLists.add(found.id);
    // Позиция в карточке — по `sort_order`, как в интерфейсе (в ответе GET порядок другой).
    const current = found.items
      .map((x, i) => ({ x, i }))
      .sort((a, b) => (a.x.sortOrder ?? a.i) - (b.x.sortOrder ?? b.i))
      .map((e) => e.x);
    const match: Array<number | undefined> = list.items.map(() => undefined);
    const used = new Set<number>();
    const pair = (test: (have: string, want: string) => boolean): void => {
      list.items.forEach((item, w) => {
        if (match[w] !== undefined) return;
        const index = current.findIndex((x, i) => !used.has(i) && test(x.text, item.text));
        if (index === -1) return;
        match[w] = index;
        used.add(index);
      });
    };
    pair((have, want) => have.trim() === want.trim());
    pair((have, want) => itemKey(have) === itemKey(want));
    // Первая доставка по месту не сопоставляет: непарный пункт карточки мог завести человек.
    list.items.forEach((_, w) => {
      if (!firstDelivery && match[w] === undefined && w < current.length && !used.has(w)) {
        match[w] = w;
        used.add(w);
      }
    });

    list.items.forEach((item, w) => {
      const sortOrder = w + 1;
      const index = match[w];
      if (index === undefined) {
        diff.addItems.push({ listId: found.id, item, sortOrder });
        return;
      }
      const have = current[index];
      if (have.id === undefined) return;
      const update: ItemUpdate = { listId: found.id, itemId: have.id };
      if (have.text.trim() !== item.text.trim()) update.text = item.text;
      if (have.checked !== item.checked) {
        if (!item.checked && firstDelivery) diff.keptTicks.push(have.text);
        else update.checked = item.checked;
      }
      if (have.sortOrder !== sortOrder) update.sortOrder = sortOrder;
      if (update.text !== undefined || update.checked !== undefined || update.sortOrder !== undefined) diff.updateItems.push(update);
    });

    current.forEach((have, i) => {
      if (used.has(i)) return;
      if (firstDelivery) diff.keptItems.push(have.text);
      else if (have.id !== undefined) diff.deleteItems.push({ listId: found.id, itemId: have.id, text: have.text });
    });
  }
  for (const list of existing) {
    if (usedLists.has(list.id) || !list.name.startsWith(AGENT_PREFIX)) continue;
    if (firstDelivery) diff.keptLists.push(list.name);
    else diff.deleteLists.push({ listId: list.id, name: list.name });
  }
  return diff;
}

export function emptyDiff(diff: ChecklistDiff): boolean {
  return (
    diff.createLists.length === 0 &&
    diff.deleteLists.length === 0 &&
    diff.addItems.length === 0 &&
    diff.updateItems.length === 0 &&
    diff.deleteItems.length === 0
  );
}

// ── поля карточки ────────────────────────────────────────────────────────

const key = (id: number): string => `id_${id}`;

function selectValue(values: Record<string, number> | undefined, value: string | undefined): number[] | undefined {
  if (!values || value === undefined) return undefined;
  const id = values[value];
  return id === undefined ? undefined : [id];
}

/** Поля признака и сегодняшняя дата, от которой считается возраст задачи. */
export type JuniorSync = JuniorFields & { today: string };

/** Признаки проекта, которые синхронизация пишет в поля карточки; нет — поле не пишется. */
export interface FieldFlags {
  junior?: JuniorSync;
  visual?: VisualFields;
}

/**
 * Поля, которыми владеет файл: «Суть», «Репозиторий» и, если проект ведёт
 * признаки, «Можно младшему», «Младшему не хватает» и «Было / Стало».
 * «Можно младшему» не применим (эпик, задача взята или закрыта) — поле
 * пустое: `null`. «Было / Стало» пишется, только когда ответ есть в задаче.
 */
export function fileProperties(task: TaskRecord, mapping: ConfigMapping, flags: FieldFlags = {}): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (mapping.summaryProperty) props[key(mapping.summaryProperty.id)] = task.fm.summary;
  const repo = selectValue(mapping.repoProperty?.values, task.fm.repo);
  if (mapping.repoProperty && repo) props[key(mapping.repoProperty.id)] = repo;
  const { junior, visual } = flags;
  if (junior) {
    const readiness = juniorReadiness(task.fm, task.body, junior);
    props[key(junior.property.id)] = readiness === null ? null : [readiness.ok ? junior.property.yes : junior.property.no];
    props[key(junior.missingPropertyId)] = readiness === null || readiness.ok ? null : juniorMissingText(readiness.missing);
  }
  // Ответа в задаче нет — поле не трогаем: его могли поставить руками в Kaiten задаче, закрытой мимо kaiten.
  if (visual && task.fm.visual !== undefined) props[key(visual.property.id)] = [visual.property[task.fm.visual]];
  return props;
}

export interface CreateFields {
  /** Команда, с которой создаётся карточка. */
  team?: string;
  title: string;
  external_id: string;
  column_id?: number;
  lane_id?: number;
  type_id?: number;
  properties: Record<string, unknown>;
}

/** Поля новой карточки: колонка, тип, приоритет и команда — только сейчас (решение 9). */
export function createFields(task: TaskRecord, mapping: ConfigMapping, defaultTeam: string | undefined, flags: FieldFlags = {}): CreateFields {
  // Пустое новой карточке не передаём: у неё и так ничего нет.
  const props = Object.fromEntries(Object.entries(fileProperties(task, mapping, flags)).filter(([, v]) => v !== null));
  const priority = selectValue(mapping.priorityProperty?.values, task.fm.priority);
  if (mapping.priorityProperty && priority) props[key(mapping.priorityProperty.id)] = priority;
  const team = selectValue(mapping.teamProperty?.values, task.fm.team ?? defaultTeam);
  if (mapping.teamProperty && team) props[key(mapping.teamProperty.id)] = team;
  return {
    team: team ? (task.fm.team ?? defaultTeam) : undefined,
    title: task.fm.title,
    // Ключ идемпотентности v2 — вечный id задачи: повтор после обрыва найдёт карточку, а не создаст вторую.
    external_id: task.fm.id,
    column_id: mapping.columns[task.fm.status],
    lane_id: productLane(task, mapping),
    type_id: mapping.types?.[task.fm.type],
    properties: props,
  };
}

// ── дорожки ──────────────────────────────────────────────────────────────

/** Сколько закрытая карточка стоит в «Сделано»/«Отменено», прежде чем уйти в «Архив» (владелец 07.10). */
export const ARCHIVE_AFTER_DAYS = 30;

/**
 * Дорожка продукта задачи; продукта без дорожки и эпика — дорожка по
 * умолчанию. Эпик объединяет задачи и не принадлежит дорожке продукта, даже
 * если у него есть `repo`; к тому же ограничение «эпик в „Сделано“ — только с
 * закрытыми дочерними» Kaiten применяет и к смене дорожки (живьём 07.10).
 */
export function productLane(task: TaskRecord, mapping: ConfigMapping): number | undefined {
  if (task.fm.type === 'epic') return mapping.laneId;
  return (task.fm.repo !== undefined ? mapping.repoLanes?.[task.fm.repo] : undefined) ?? mapping.laneId;
}

/**
 * Куда переложить карточку; `undefined` — оставить, где лежит. Дорожка —
 * раскладка доски, а продукт хранит поле «Репозиторий»: по «Архиву» его
 * иначе не узнать (владелец 07.10). Поэтому ручной перенос между дорожками
 * не откатываем, а двигаем только по событиям:
 *   · закрыта больше `ARCHIVE_AFTER_DAYS` дней назад — в «Архив»;
 *   · открыта снова, а лежит в «Архиве», — в дорожку продукта;
 *   · сменился продукт (поле «Репозиторий» расходится с файлом) — в дорожку
 *     нового продукта, если карточка не в «Архиве»;
 *   · лежит в дорожке по умолчанию, а у продукта своя, — в неё: так
 *     раскладываются карточки, заведённые до дорожек.
 */
export function laneMove(task: TaskRecord, card: CardView, mapping: ConfigMapping, repoChanged: boolean, now: number): number | undefined {
  if (card.laneId === undefined) return undefined;
  const status = reverse<TaskStatus>(mapping.columns, STATUSES).get(card.columnId ?? -1) ?? task.fm.status;
  const closed = CLOSED_STATUSES.includes(status);
  const archive = mapping.archiveLaneId;
  const inArchive = archive !== undefined && card.laneId === archive;
  let target: number | undefined;
  if (archive !== undefined && closed && card.columnChangedAt !== undefined && now - Date.parse(card.columnChangedAt) > ARCHIVE_AFTER_DAYS * 86_400_000) {
    target = archive;
  } else if (inArchive && !closed) target = productLane(task, mapping);
  else if ((repoChanged || card.laneId === mapping.laneId) && !inArchive) target = productLane(task, mapping);
  return target !== undefined && target !== card.laneId ? target : undefined;
}

/**
 * Пора ли карточке в архив Kaiten (`kaiten.archiveInKaiten`): стоит в
 * закрытой колонке больше `ARCHIVE_AFTER_DAYS` дней. Эпик — только когда у
 * него не осталось живых дочерних карточек: после архива эпика Kaiten может
 * потерять связь с задачей (docs/kaiten-api.md), а синхронизация пыталась бы
 * связать её с архивным эпиком снова.
 */
export function archiveDue(card: CardView, mapping: ConfigMapping, cards: readonly CardView[], now: number): boolean {
  if (card.archived || card.columnChangedAt === undefined) return false;
  const status = reverse<TaskStatus>(mapping.columns, STATUSES).get(card.columnId ?? -1);
  if (status === undefined || !CLOSED_STATUSES.includes(status)) return false;
  if (now - Date.parse(card.columnChangedAt) <= ARCHIVE_AFTER_DAYS * 86_400_000) return false;
  return !cards.some((c) => !c.archived && c.parents.includes(card.id));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── план ─────────────────────────────────────────────────────────────────

// ── файлы карточки: вложения и журнал ────────────────────────────────────

/** Вложение задачи в репозитории задач: имя внутри папки вложений и git-объект. */
export interface AttachmentRef {
  name: string;
  sha: string;
  size: number;
}

/** Файл, который должен лежать в карточке: вложение (содержимое — по `sha`) или журнал (`text`). */
export interface TaskFile {
  name: string;
  sha: string;
  size: number;
  text?: string;
}

/** Что отправить в файлы карточки и хеш, который после этого запишется в `files_hash`. */
export interface FilesDelivery {
  wanted: TaskFile[];
  hash: string;
}

/** Файлы карточки — вложения задачи; журнал — ссылкой в описании (`journalUrl`). */
export function taskFiles(attachments: readonly AttachmentRef[]): TaskFile[] {
  return [...attachments].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ ...a }));
}

/** Журнал, который синхронизация прикладывала файлом до 20.10.2026, — убрать из карточки. */
export const RETIRED_FILES: readonly string[] = [JOURNAL_FILE];

export function filesHash(files: readonly TaskFile[]): string {
  const payload = JSON.stringify(files.map((f) => [f.name, f.sha]));
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export type SyncAction =
  | {
      kind: 'create';
      task: TaskRecord;
      fields: CreateFields;
      content: RenderedContent;
      contentHash: string;
      parentRef: string | null;
      /** Файлы новой карточки; `files_hash` ставится и без файлов — дальше доставка сама. */
      files: FilesDelivery | null;
    }
  | {
      kind: 'update';
      task: TaskRecord;
      cardId: number;
      /** Заголовок и поля файла, разошедшиеся с карточкой; дорожка — `laneMove`. */
      patch: { title?: string; properties?: Record<string, unknown>; lane_id?: number };
      /** Описание и чек-листы — если содержимое файла ещё не доставлено. */
      content: RenderedContent | null;
      contentHash: string;
      /** Карточка ещё ни разу не получала содержимое (`content_hash` нет) — галочки Kaiten не снимаем. */
      firstDelivery: boolean;
      /** Файлы — если изменились с последней доставки (или `--resend`). */
      files: FilesDelivery | null;
      /** В архив Kaiten — последней записью, после описания и файлов (`archiveDue`). */
      archive: boolean;
    }
  | { kind: 'link'; task: TaskRecord; parentId: number; childId: number }
  /** Статус сменили без Kaiten (`pending_moves`): довести карточку по шагам, раньше остальных записей. */
  | { kind: 'replay'; task: TaskRecord; cardId: number; from: TaskStatus; steps: ReplayStep[]; total: number };

export interface ReplayStep {
  status: TaskStatus;
  columnId: number;
  properties?: Record<string, unknown>;
  /** Открытый статус: карточку достаём и из архива Kaiten, как `kaiten start`. */
  reopen: boolean;
}

export interface SyncReport {
  /** Карточки нет в списке доски (архив или удалена) — не создаём заново. */
  missingCards: string[];
  /** Ключ не числовой (PRJ-123): пока пространства без ключей, сопоставить нечем. */
  unknownTrackers: string[];
  ignored: string[];
  /** Карточка в архиве Kaiten — не трогаем. */
  archivedCards: string[];
  /** Перенесённые задачи без карточки — первая заливка, только скриптом владельца. */
  firstLoadCandidates: number;
  /** Закрытые задачи CLI без карточки — не создаём. */
  closedWithoutCard: string[];
  /** Карточка в колонке, которой нет в конфиге, — статус не переносим. */
  unknownColumns: string[];
  /** Пока Kaiten был недоступен для этой машины, карточку передвинул человек: его решение важнее очереди. */
  movedByHuman: Array<{ ref: string; status: TaskStatus }>;
  /**
   * На ревью или закрыта с `kaiten.visual.since`, а ответа «Было / Стало» нет:
   * карточку перенесли в Kaiten руками. По состоянию, а не по переходу — переход
   * мог зеркалить в файл чужой фоновый проход.
   */
  withoutVisual: string[];
}

export interface SyncPlan {
  actions: SyncAction[];
  /** Поля Kaiten, разошедшиеся с файлами, — в файлы. */
  mirror: MirrorItem[];
  /** Как назвать задачу в выводе: id → ключ карточки. */
  names: Record<string, string>;
  report: SyncReport;
  /** Сколько карточек получат «Можно младшему»: «Да», «Нет», пустое — для сухого прогона владельца. */
  junior?: { yes: number; no: number; cleared: number };
}

export interface PlanInput {
  tasks: readonly TaskRecord[];
  cards: readonly CardView[];
  mapping: ConfigMapping;
  ignore: readonly number[];
  repoWebBase: string | null;
  defaultTeam?: string;
  /**
   * Первая заливка (скрипт владельца): карточки и перенесённым задачам —
   * открытым и сделанным не раньше `closedSince` (YYYY-MM, Q19: «done за три
   * месяца»); отменённым — только с `withCancelled`.
   */
  firstLoad?: { closedSince: string; withCancelled?: boolean };
  /**
   * Отправить описание и чек-листы заново, даже если хеш совпал: так
   * приводятся к файлу карточки, доставленные прежними правилами. Только
   * скрипт владельца (сухой прогон, затем `--apply`) — фон этого не делает.
   */
  resend?: boolean;
  /**
   * Вложения задач по slug. Нет — файлы карточек не трогаем совсем (папка
   * вместо хранилища, тесты без файлов): иначе план счёл бы вложения пропавшими.
   */
  attachments?: ReadonlyMap<string, readonly AttachmentRef[]>;
  /** Только эти задачи (id) — пробный прогон на одной карточке. */
  only?: ReadonlySet<string>;
  /** «Сейчас», мс — от него отсчитывается переезд в «Архив»; по умолчанию часы машины. */
  now?: number;
  /** Закрытые больше `ARCHIVE_AFTER_DAYS` дней — в архив Kaiten (`kaiten.archiveInKaiten`), дорожка «Архив» не используется. */
  archiveInKaiten?: boolean;
  /** Поля «Можно младшему» (`kaiten.junior` и id из `setup`); нет — не пишем. */
  junior?: JuniorFields;
  /** Поле «Было / Стало» (`kaiten.visual` и id из `setup`); нет — не пишем. */
  visual?: VisualFields;
}

function reverse<T extends string>(values: Partial<Record<T, number>> | Record<string, number> | undefined, allowed: readonly T[]): Map<number, T> {
  const out = new Map<number, T>();
  for (const [k, v] of Object.entries(values ?? {})) if ((allowed as readonly string[]).includes(k) && typeof v === 'number') out.set(v, k as T);
  return out;
}

/**
 * Дата Kaiten по Москве (`taskDate`), а не по UTC и не по часам машины:
 * `column_changed_at` приходит в UTC (живьём 29.09), и закрытие в ночь на 1-е
 * иначе ушло бы в прошлый месяц, а у машин в разных поясах — в разные. Строка
 * без времени (`YYYY-MM-DD`) — как есть: так приходит срок без времени
 * (`toCardView` отрезает полночь UTC, живьём 29.09).
 */
export function localDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return taskDate(d);
}

function firstId(value: unknown): number | null {
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null;
}

/**
 * Что Kaiten знает о задаче иначе, чем файл: только поля Kaiten. Пусто —
 * `item: null`. Колонка не из конфига — статус не трогаем и сообщаем.
 */
export function mirrorFromCard(task: TaskRecord, card: CardView, mapping: ConfigMapping, keepOwn = false): { item: MirrorItem | null; unknownColumn: boolean } {
  const item: MirrorItem = { id: task.fm.id };
  let changed = false;
  let unknownColumn = false;

  // `keepOwn` — карточка ещё догоняет файл: её статус и приоритет устарели.
  if (card.columnId !== undefined && !keepOwn) {
    const status = reverse<TaskStatus>(mapping.columns, STATUSES).get(card.columnId);
    if (status === undefined) unknownColumn = true;
    else if (status !== task.fm.status) {
      item.status = status;
      if (card.columnChangedAt) item.closedMonth = localDate(card.columnChangedAt).slice(0, 7);
      changed = true;
    }
  }
  if (card.typeId !== undefined) {
    const type = reverse<TaskType>(mapping.types, TASK_TYPES).get(card.typeId);
    if (type !== undefined && type !== task.fm.type) {
      item.type = type;
      changed = true;
    }
  }
  if (mapping.priorityProperty && !keepOwn) {
    const id = firstId(card.properties[key(mapping.priorityProperty.id)]);
    const priority: Priority | null = id === null ? null : (reverse<Priority>(mapping.priorityProperty.values, PRIORITIES).get(id) ?? null);
    if (priority !== (task.fm.priority ?? null)) {
      item.priority = priority;
      changed = true;
    }
  }
  if (mapping.teamProperty) {
    const id = firstId(card.properties[key(mapping.teamProperty.id)]);
    const names = new Map(Object.entries(mapping.teamProperty.values).map(([name, value]) => [value, name]));
    const team = id === null ? null : (names.get(id) ?? null);
    if (team !== (task.fm.team ?? null)) {
      item.team = team;
      changed = true;
    }
  }
  // «Оценка» — только у проекта, где поле заведено: иначе в файлах не появится незнакомый старым `kaiten` ключ.
  if (mapping.assessProperty) {
    const id = firstId(card.properties[key(mapping.assessProperty.id)]);
    const assessment: AssessVerdict | null = id === null ? null : (reverse<AssessVerdict>(mapping.assessProperty.values, ASSESS_VERDICTS).get(id) ?? null);
    if (assessment !== (task.fm.assessment ?? null)) {
      item.assessment = assessment;
      changed = true;
    }
  }
  if (card.dueDate !== undefined) {
    const due = card.dueDate ? localDate(card.dueDate) : null;
    if (due !== (task.fm.planning?.due ?? null)) {
      item.due = due;
      changed = true;
    }
  }
  return { item: changed ? item : null, unknownColumn };
}

function cardIdOf(tracker: string | undefined): number | null {
  return tracker !== undefined && /^\d+$/.test(tracker) ? Number(tracker) : null;
}

type PendingDecision =
  /** Карточка уже там, где файл: очередь снять. */
  | { kind: 'settled' }
  /** Карточку передвинул человек позже смены статуса: побеждает он. */
  | { kind: 'human'; status: TaskStatus }
  | { kind: 'replay'; steps: ReplayStep[] };

/**
 * Что делать со статусом, сменённым без Kaiten. Карточка могла дойти до части
 * шагов (обрыв на середине) — тогда только оставшиеся: колонка из очереди значит
 * «дошла сюда», а не «передвинул человек».
 */
export function pendingDecision(task: TaskRecord, card: CardView, mapping: ConfigMapping): PendingDecision {
  const pending = task.fm.pending_moves;
  if (!pending) return { kind: 'settled' };
  const priorityProperty = mapping.priorityProperty;
  const steps = pending.steps.flatMap((step): ReplayStep[] => {
    const columnId = mapping.columns[step.status];
    if (columnId === undefined) return [];
    const value = step.priority !== undefined ? priorityProperty?.values[step.priority] : undefined;
    const properties = priorityProperty && value !== undefined ? { [key(priorityProperty.id)]: [value] } : undefined;
    return [{ status: step.status, columnId, ...(properties ? { properties } : {}), reopen: !CLOSED_STATUSES.includes(step.status) }];
  });
  if (steps.length === 0) return { kind: 'settled' };
  const reached = steps.map((s) => s.columnId).lastIndexOf(card.columnId ?? -1);
  if (reached === steps.length - 1) return { kind: 'settled' };
  if (reached >= 0) return { kind: 'replay', steps: steps.slice(reached + 1) };
  const movedAfter = card.columnChangedAt !== undefined && Date.parse(card.columnChangedAt) > Date.parse(pending.since);
  if (movedAfter && card.columnId !== mapping.columns[pending.from]) {
    const status = reverse<TaskStatus>(mapping.columns, STATUSES).get(card.columnId ?? -1);
    if (status !== undefined) return { kind: 'human', status };
  }
  return { kind: 'replay', steps };
}

export function planKaitenSync(input: PlanInput): SyncPlan {
  const { tasks, mapping } = input;
  const cards = new Map(input.cards.map((c) => [c.id, c]));
  const ignore = new Set(input.ignore);
  const report: SyncReport = { missingCards: [], unknownTrackers: [], ignored: [], archivedCards: [], firstLoadCandidates: 0, closedWithoutCard: [], unknownColumns: [], movedByHuman: [], withoutVisual: [] };
  const mirror: MirrorItem[] = [];
  const names: Record<string, string> = {};
  const replays: SyncAction[] = [];
  const creates: SyncAction[] = [];
  const others: SyncAction[] = [];
  // Возраст задачи — от сегодняшнего дня того же «сейчас», что и переезд в архив.
  const junior: JuniorSync | undefined = input.junior ? { ...input.junior, today: localDate(new Date(input.now ?? Date.now()).toISOString()) } : undefined;
  const flags: FieldFlags = { junior, visual: input.visual };
  const delivery = (task: TaskRecord): FilesDelivery | null => {
    if (!input.attachments) return null;
    const wanted = taskFiles(input.attachments.get(task.slug) ?? []);
    return { wanted, hash: filesHash(wanted) };
  };

  for (const task of tasks) {
    if (input.only && !input.only.has(task.fm.id)) continue;
    const hash = deliveredHash(task, tasks, input.repoWebBase);
    if (task.fm.tracker === undefined) {
      const bornInCli = task.fm.created_via !== undefined;
      const archiveMonth = /^archive\/(\d{4}-\d{2})\//.exec(task.path)?.[1];
      const load = input.firstLoad;
      const closedOk = load !== undefined && archiveMonth !== undefined && archiveMonth >= load.closedSince && (task.fm.status === 'done' || load.withCancelled === true);
      const firstLoadOk = load !== undefined && (!task.closed || closedOk);
      if (!bornInCli && !firstLoadOk) {
        if (!task.closed) report.firstLoadCandidates += 1;
        continue;
      }
      if (task.closed && !firstLoadOk) {
        report.closedWithoutCard.push(task.slug);
        continue;
      }
      const epic = epicOf(tasks, task);
      creates.push({
        kind: 'create',
        task,
        fields: createFields(task, mapping, input.defaultTeam, flags),
        content: renderContent(task, tasks, input.repoWebBase),
        contentHash: hash,
        parentRef: epic ? epic.fm.id : null,
        files: delivery(task),
      });
      continue;
    }

    const cardId = cardIdOf(task.fm.tracker);
    if (cardId === null) {
      report.unknownTrackers.push(`${task.slug} (${task.fm.tracker})`);
      continue;
    }
    if (ignore.has(cardId)) {
      report.ignored.push(`${task.slug} (${cardId})`);
      continue;
    }
    const card = cards.get(cardId);
    const pending = task.fm.pending_moves;
    if (!card) {
      report.missingCards.push(`${task.slug} (${cardId})`);
      // Двигать нечего — задача не должна вечно ждать карточку, которой нет.
      if (pending) {
        mirror.push({ id: task.fm.id, settled: 'all' });
        names[task.fm.id] = `${task.fm.tracker} (${task.slug})`;
      }
      continue;
    }
    const decision = pending ? pendingDecision(task, card, mapping) : null;
    if (pending && decision?.kind === 'replay') {
      replays.push({ kind: 'replay', task, cardId, from: pending.from, steps: decision.steps, total: pending.steps.length });
    }
    if (card.archived && decision?.kind !== 'replay') {
      if (pending) {
        mirror.push({ id: task.fm.id, settled: 'all' });
        names[task.fm.id] = `${task.fm.tracker} (${task.slug})`;
      }
      // Закрытое уходит в штатный архив Kaiten — это порядок, а не находка;
      // в отчёт — только открытая задача с карточкой в архиве.
      if (!CLOSED_STATUSES.includes(task.fm.status)) report.archivedCards.push(`${task.slug} (${cardId})`);
      continue;
    }

    const fromKaiten = mirrorFromCard(task, card, mapping, decision?.kind === 'replay');
    if (fromKaiten.unknownColumn) report.unknownColumns.push(`${task.slug} (${cardId})`);
    const settled: Partial<MirrorItem> =
      decision?.kind === 'settled' && pending
        ? { settled: pending.steps.length }
        : decision?.kind === 'human'
          ? { settled: 'all', status: decision.status, note: `карточку передвинули в Kaiten, пока он был недоступен отсюда: статус ${decision.status}` }
          : {};
    if (decision?.kind === 'human') report.movedByHuman.push({ ref: refOf(task), status: decision.status });
    if (fromKaiten.item || settled.settled !== undefined) {
      mirror.push({ ...(fromKaiten.item ?? { id: task.fm.id }), ...settled });
      names[task.fm.id] = `${task.fm.tracker} (${task.slug})`;
    }
    if (input.visual && missingVisual(task, fromKaiten.item?.status ?? task.fm.status, card, input.visual)) report.withoutVisual.push(`${task.fm.tracker} (${task.slug})`);

    const patch: { title?: string; properties?: Record<string, unknown>; lane_id?: number } = {};
    if (!sameValue(card.title, task.fm.title)) patch.title = task.fm.title;
    const wanted = fileProperties(task, mapping, flags);
    const diff = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => !sameValue(card.properties[k], v)));
    if (Object.keys(diff).length > 0) patch.properties = diff;
    const repoKey = mapping.repoProperty ? key(mapping.repoProperty.id) : null;
    const now = input.now ?? Date.now();
    // Архив Kaiten вместо дорожки: id дорожки «Архив» из маппинга не используется.
    const laneMapping = input.archiveInKaiten ? { ...mapping, archiveLaneId: undefined } : mapping;
    const lane = laneMove(task, card, laneMapping, repoKey !== null && repoKey in diff, now);
    if (lane !== undefined) patch.lane_id = lane;
    const archive = input.archiveInKaiten === true && archiveDue(card, mapping, input.cards, now);
    const stale = input.resend === true || task.fm.content_hash !== hash;
    // Файлы: сами — только задачам, у которых `files_hash` уже есть (Q10); остальным —
    // `--resend`, открытым или названным через `--only` (Q11).
    const files = delivery(task);
    const filesStale =
      files !== null &&
      ((task.fm.files_hash !== undefined && task.fm.files_hash !== files.hash) || (input.resend === true && (!task.closed || input.only !== undefined)));
    if (stale || filesStale || archive || patch.title !== undefined || patch.properties !== undefined || patch.lane_id !== undefined) {
      others.push({
        kind: 'update',
        task,
        cardId,
        patch,
        content: stale ? renderContent(task, tasks, input.repoWebBase) : null,
        contentHash: hash,
        firstDelivery: task.fm.content_hash === undefined,
        files: filesStale ? files : null,
        archive,
      });
    }

    const epic = epicOf(tasks, task);
    const parentId = cardIdOf(epic?.fm.tracker);
    // К архивному эпику не привязываем: Kaiten может потерять связь, и попытка повторялась бы каждый раз.
    if (parentId !== null && !ignore.has(parentId) && !card.parents.includes(parentId) && cards.get(parentId)?.archived !== true) {
      others.push({ kind: 'link', task, parentId, childId: cardId });
    }
  }

  // Эпики — раньше задач: новой задаче нужна уже существующая карточка эпика.
  creates.sort((a, b) => Number(b.task.fm.type === 'epic') - Number(a.task.fm.type === 'epic'));
  // Статусы — первыми: остальное (архив, дорожка) считается по уже догнавшей карточке на следующем проходе.
  const actions = [...replays, ...creates, ...others];
  return { actions, mirror, names, report, ...(junior ? { junior: juniorCounts(actions, junior) } : {}) };
}

/**
 * На ревью или «Сделано» с `since` без ответа «Было / Стало» — ни в задаче, ни
 * в карточке (его можно поставить руками в Kaiten). Дата — переноса в колонку.
 */
function missingVisual(task: TaskRecord, status: TaskStatus, card: CardView, visual: VisualFields): boolean {
  if (task.fm.visual !== undefined || !visualApplies(task.fm.type)) return false;
  if (firstId(card.properties[key(visual.property.id)]) !== null) return false;
  if (status !== 'review' && status !== 'done') return false;
  return card.columnChangedAt !== undefined && localDate(card.columnChangedAt) >= visual.since;
}

function juniorCounts(actions: readonly SyncAction[], junior: JuniorSync): NonNullable<SyncPlan['junior']> {
  const counts = { yes: 0, no: 0, cleared: 0 };
  const field = key(junior.property.id);
  for (const a of actions) {
    const props = a.kind === 'create' ? a.fields.properties : a.kind === 'update' ? a.patch.properties : undefined;
    if (!props || !(field in props)) continue;
    const value = props[field];
    if (value === null) counts.cleared += 1;
    else if (sameValue(value, [junior.property.yes])) counts.yes += 1;
    else counts.no += 1;
  }
  return counts;
}
