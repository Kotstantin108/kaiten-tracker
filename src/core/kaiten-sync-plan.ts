/**
 * План синхронизации задач с Kaiten — чистая часть (этап 2a: файл → Kaiten).
 *
 * ЧТО ПИШЕТ ФАЙЛ В КАРТОЧКУ (Q1, решение 9): заголовок, «Суть», «Репозиторий»,
 * описание (первая строка — пометка Q41), чек-листы «Агент · <раздел>»
 * (Q43), связь с эпиком. Колонку, тип, приоритет и команду — только при
 * создании карточки: дальше ими владеет Kaiten.
 *
 * КОГДА ОБНОВЛЯТЬ. `content_hash` в файле — «это содержимое карточка уже
 * получила»; его ставит только синхронизация (операция `synced`). Пересчитанный
 * хеш не равен записанному (или его нет, как у перенесённых задач) — описание
 * и чек-листы нужно отправить (Q32). Заголовок, «Суть» и «Репозиторий» видны в
 * списке карточек и сравниваются напрямую: правка их в интерфейсе Kaiten
 * возвращается к файлу (владелец — файл).
 *
 * КОГДА СОЗДАВАТЬ. Сама — только задачи, рождённые в CLI (`created_via` есть;
 * у перенесённых его нет по решению владельца) и ещё открытые. Перенесённые
 * задачи без карточки — «первая заливка», она идёт только скриптом владельца
 * с `--first-load` (AGENTS.md: массовые мутации — по «да» на план).
 *
 * ЧЕГО НЕ ДЕЛАЕТ НИКОГДА: не трогает карточки из `ignoreCards`; не создаёт
 * заново карточку, которой нет в списке доски (архив или удалена) — это в
 * отчёт; не удаляет пункты чек-листов, которых нет в файле.
 */

import { extractChecklists, type Checklist } from '../checklists.js';
import type { ConfigMapping } from '../config.js';
import { contentHash } from './document.js';
import { epicOf, type TaskRecord } from './tasks-index.js';

/** Первая строка описания карточки (Q41). */
export const Q41_NOTICE = 'Текст обновляется автоматически из репозитория. Правки — комментарием.';

/** То, что синхронизация читает из списка карточек доски. */
export interface CardView {
  id: number;
  title: string;
  externalId: string | null;
  parents: number[];
  properties: Record<string, unknown>;
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
export function renderContent(task: TaskRecord, all: readonly TaskRecord[], base: string | null): RenderedContent {
  const { body, checklists } = extractChecklists(task.body.trim());
  return {
    description: `${Q41_NOTICE}\n\n${linkify(body, all, base).trim()}\n`,
    checklists: checklists.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, text: linkify(i.text, all, base) })) })),
  };
}

// ── поля карточки ────────────────────────────────────────────────────────

const key = (id: number): string => `id_${id}`;

function selectValue(values: Record<string, number> | undefined, value: string | undefined): number[] | undefined {
  if (!values || value === undefined) return undefined;
  const id = values[value];
  return id === undefined ? undefined : [id];
}

/** Поля, которыми владеет файл: «Суть» и «Репозиторий». */
export function fileProperties(task: TaskRecord, mapping: ConfigMapping): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (mapping.summaryProperty) props[key(mapping.summaryProperty.id)] = task.fm.summary;
  const repo = selectValue(mapping.repoProperty?.values, task.fm.repo);
  if (mapping.repoProperty && repo) props[key(mapping.repoProperty.id)] = repo;
  return props;
}

export interface CreateFields {
  title: string;
  external_id: string;
  column_id?: number;
  lane_id?: number;
  type_id?: number;
  properties: Record<string, unknown>;
}

/** Поля новой карточки: колонка, тип, приоритет и команда — только сейчас (решение 9). */
export function createFields(task: TaskRecord, mapping: ConfigMapping, defaultTeam: string | undefined): CreateFields {
  const props = fileProperties(task, mapping);
  const priority = selectValue(mapping.priorityProperty?.values, task.fm.priority);
  if (mapping.priorityProperty && priority) props[key(mapping.priorityProperty.id)] = priority;
  const team = selectValue(mapping.teamProperty?.values, task.fm.team ?? defaultTeam);
  if (mapping.teamProperty && team) props[key(mapping.teamProperty.id)] = team;
  return {
    title: task.fm.title,
    // Ключ идемпотентности v2 — вечный id задачи: повтор после обрыва найдёт карточку, а не создаст вторую.
    external_id: task.fm.id,
    column_id: mapping.columns[task.fm.status],
    lane_id: mapping.laneId,
    type_id: mapping.types?.[task.fm.type],
    properties: props,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── план ─────────────────────────────────────────────────────────────────

export type SyncAction =
  | { kind: 'create'; task: TaskRecord; fields: CreateFields; content: RenderedContent; contentHash: string; parentRef: string | null }
  | {
      kind: 'update';
      task: TaskRecord;
      cardId: number;
      /** Заголовок и поля файла, разошедшиеся с карточкой. */
      patch: { title?: string; properties?: Record<string, unknown> };
      /** Описание и чек-листы — если содержимое файла ещё не доставлено. */
      content: RenderedContent | null;
      contentHash: string;
    }
  | { kind: 'link'; task: TaskRecord; parentId: number; childId: number };

export interface SyncReport {
  /** Карточки нет в списке доски (архив или удалена) — не создаём заново. */
  missingCards: string[];
  /** Ключ не числовой (PRJ-123): пока пространства без ключей, сопоставить нечем. */
  unknownTrackers: string[];
  ignored: string[];
  /** Перенесённые задачи без карточки — первая заливка, только скриптом владельца. */
  firstLoadCandidates: number;
  /** Закрытые задачи CLI без карточки — не создаём. */
  closedWithoutCard: string[];
}

export interface SyncPlan {
  actions: SyncAction[];
  report: SyncReport;
}

export interface PlanInput {
  tasks: readonly TaskRecord[];
  cards: readonly CardView[];
  mapping: ConfigMapping;
  ignore: readonly number[];
  repoWebBase: string | null;
  defaultTeam?: string;
  /** Первая заливка (скрипт владельца): создать карточки и перенесённым задачам, открытым и закрытым не раньше `closedSince` (YYYY-MM). */
  firstLoad?: { closedSince: string };
}

function cardIdOf(tracker: string | undefined): number | null {
  return tracker !== undefined && /^\d+$/.test(tracker) ? Number(tracker) : null;
}

export function planKaitenSync(input: PlanInput): SyncPlan {
  const { tasks, mapping } = input;
  const cards = new Map(input.cards.map((c) => [c.id, c]));
  const ignore = new Set(input.ignore);
  const report: SyncReport = { missingCards: [], unknownTrackers: [], ignored: [], firstLoadCandidates: 0, closedWithoutCard: [] };
  const creates: SyncAction[] = [];
  const others: SyncAction[] = [];

  for (const task of tasks) {
    const hash = contentHash(task.fm, task.body);
    if (task.fm.tracker === undefined) {
      const bornInCli = task.fm.created_via !== undefined;
      const archiveMonth = /^archive\/(\d{4}-\d{2})\//.exec(task.path)?.[1];
      const firstLoadOk = input.firstLoad !== undefined && (!task.closed || (archiveMonth !== undefined && archiveMonth >= input.firstLoad.closedSince));
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
        fields: createFields(task, mapping, input.defaultTeam),
        content: renderContent(task, tasks, input.repoWebBase),
        contentHash: hash,
        parentRef: epic ? epic.fm.id : null,
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
    if (!card) {
      report.missingCards.push(`${task.slug} (${cardId})`);
      continue;
    }

    const patch: { title?: string; properties?: Record<string, unknown> } = {};
    if (!sameValue(card.title, task.fm.title)) patch.title = task.fm.title;
    const wanted = fileProperties(task, mapping);
    const diff = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => !sameValue(card.properties[k], v)));
    if (Object.keys(diff).length > 0) patch.properties = diff;
    const stale = task.fm.content_hash !== hash;
    if (stale || patch.title !== undefined || patch.properties !== undefined) {
      others.push({ kind: 'update', task, cardId, patch, content: stale ? renderContent(task, tasks, input.repoWebBase) : null, contentHash: hash });
    }

    const epic = epicOf(tasks, task);
    const parentId = cardIdOf(epic?.fm.tracker);
    if (parentId !== null && !ignore.has(parentId) && !card.parents.includes(parentId)) {
      others.push({ kind: 'link', task, parentId, childId: cardId });
    }
  }

  // Эпики — раньше задач: новой задаче нужна уже существующая карточка эпика.
  creates.sort((a, b) => Number(b.task.fm.type === 'epic') - Number(a.task.fm.type === 'epic'));
  return { actions: [...creates, ...others], report };
}
