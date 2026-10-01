/**
 * Построение плана заливки: чистая функция от «задачи в репозитории» и
 * «карточки, которые уже есть в Kaiten» к списку действий.
 *
 * ИДЕМПОТЕНТНОСТЬ. Второй прогон подряд не должен делать ни одной записи. До
 * появления формата v2 с `content_hash` во frontmatter (формат задач v2)
 * хеш живёт в самом описании карточки — строкой-маркером в конце. Она
 * невидима при рендере markdown, читается обратно из `description` и сравнивается
 * с хешем текущего тела задачи. Если описание карточки прочитать не удалось,
 * план честно говорит «не знаю» и ставит обновление, а не притворяется, что всё
 * совпало.
 *
 * ПОРЯДОК. Сначала эпики, потом остальные: связь «родитель → ребёнок» требует
 * уже существующей карточки родителя. Задача без известного родителя не
 * блокируется — уезжает без связи, а факт попадает в отчёт.
 */

import { createHash } from 'node:crypto';

import { extractChecklists, withoutAgentPrefix, type Checklist } from './checklists.js';
import type { CardPayload } from './kaiten-client.js';
import type { FolderStatus, Priority, TaskFile, TaskType } from './task-source.js';
import { rewriteRelativeLinks } from './task-source.js';

/** Маркер в конце описания карточки: скрыт при рендере, читается обратно. */
const FINGERPRINT_RE = /<!--\s*acme-sync:([a-f0-9]{16})\s*-->/;

export interface BoardMapping {
  boardId: number;
  laneId?: number;
  /** Статус → id колонки. Заполняется по выводу `inspect`. */
  columns: Partial<Record<FolderStatus, number>>;
  /** Тип задачи → id типа карточки. */
  types?: Partial<Record<TaskType, number>>;
  /** Кастомное свойство приоритета: id свойства и значения селекта. */
  priorityProperty?: { id: number; values: Partial<Record<Priority, string | number>> };
  /**
   * Поле «Репозиторий» (Q22): значение берётся из задачи. С `values` это
   * поле-выбор (имя репозитория → id варианта), без — старое строковое поле.
   * Владелец — файл, поэтому поле обновляется и у существующих карточек.
   */
  repoProperty?: { id: number; values?: Record<string, number> };
  /** Поле-выбор «Команда»: ставится при создании, дальше владеет Kaiten. */
  teamProperty?: { id: number; values: Record<string, number> };
  /** Текстовое поле «Суть»: владелец — файл, обновляется и у существующих карточек. */
  summaryProperty?: { id: number };
  /** Команда для задач из репозиториев кода — это задачи разработки. */
  defaultTeam?: string;
}

export interface ExistingCard {
  id: number;
  externalId: string;
  title?: string;
  columnId?: number;
  /** `undefined` — описание не читали (список карточек его не отдаёт). */
  description?: string;
  /**
   * Родители карточки из `parents_ids` (список карточек его отдаёт; `null` —
   * родителей нет). `undefined` — неизвестно, тогда связь планируется как раньше.
   */
  parentIds?: number[];
  /**
   * Дети карточки из `children_ids`. Нужны отдельно: живьём после архивации
   * эпика у story пропал родитель (`parents_ids = null`), а у эпика ребёнок
   * остался — связь видна только с одной стороны.
   */
  childIds?: number[];
  /** Чек-листы карточки: id, имя, тексты пунктов; `undefined` — не читали. */
  checklists?: ExistingChecklist[];
  /** Значения полей карточки (`id_<поле>` → значение); `undefined` — не читали. */
  properties?: Record<string, unknown>;
}

export interface ExistingChecklist {
  id: number;
  name: string;
  itemTexts: string[];
}

/**
 * Что досоздать: весь чек-лист (`checklistId` нет) или недостающие пункты
 * существующего. `rename` — чек-лист пилота создан без префикса «Агент · »
 * и переименовывается, а не создаётся второй раз.
 */
export interface ChecklistPatch extends Checklist {
  checklistId?: number;
  rename?: boolean;
}

export interface RenderOptions {
  /** Переписывать относительные ссылки в постоянные URL репозитория. */
  rewriteLinks: boolean;
  /**
   * «Суть» первым блоком описания. С 28.09.2026 «Суть» — отдельное поле
   * карточки, и блок нужен, только пока поля в аккаунте нет.
   */
  summaryInDescription?: boolean;
}

export type PlanAction =
  | { kind: 'create'; externalId: string; title: string; payload: CardPayload; task: TaskFile; checklists: Checklist[] }
  /**
   * Недостающее у существующей карточки: чек-лист целиком, если нет такого
   * имени, иначе — только пункты, которых нет по тексту. Имеющееся не меняется
   * и не удаляется (отметки ставят в Kaiten). Добивает и частично созданное
   * при оборванном прогоне.
   */
  | { kind: 'checklists'; externalId: string; cardId: number; checklists: ChecklistPatch[] }
  | {
      kind: 'update';
      externalId: string;
      cardId: number;
      payload: Partial<CardPayload>;
      reasons: string[];
      task: TaskFile;
    }
  | { kind: 'unchanged'; externalId: string; cardId: number }
  | {
      kind: 'link';
      childExternalId: string;
      parentExternalId: string;
      childCardId: number | null;
      parentCardId: number | null;
    };

export interface PlanWarning {
  externalId: string;
  detail: string;
}

export interface ImportPlan {
  actions: PlanAction[];
  warnings: PlanWarning[];
  stats: { create: number; update: number; unchanged: number; link: number; checklists: number };
}

/** Короткий хеш тела карточки: заголовок + статус + описание без маркера + пункты чек-листов. */
export function fingerprint(parts: { title: string; status: string; description: string; checklists?: Checklist[] }): string {
  const body = parts.description.replace(FINGERPRINT_RE, '').trimEnd();
  // Пункты в описание не попадают, поэтому входят в хеш отдельно — иначе правка
  // пункта в файле не считалась бы изменением. Без пунктов хеш прежний.
  const lists = parts.checklists && parts.checklists.length > 0 ? `\n${JSON.stringify(parts.checklists)}` : '';
  return createHash('sha256').update(`${parts.title}\n${parts.status}\n${body}${lists}`).digest('hex').slice(0, 16);
}

export function readFingerprint(description: string | undefined): string | null {
  if (!description) return null;
  const m = FINGERPRINT_RE.exec(description);
  return m ? m[1] : null;
}

/**
 * Описание карточки: тело задачи как есть (markdown уезжает в Kaiten без
 * конвертации — `text_format_type_id: 1`), затем служебный хвост со ссылкой на
 * папку задачи в git и маркером идемпотентности.
 */
export function renderDescription(task: TaskFile, options: RenderOptions): string {
  return renderCard(task, options).description;
}

/**
 * Описание и чек-листы карточки. Пункты `- [ ]` уезжают из описания в
 * чек-листы: Kaiten не отображает markdown-чекбоксы (проверено живьём 23.09.2026).
 */
export function renderCard(task: TaskFile, options: RenderOptions): { description: string; checklists: Checklist[] } {
  const hasUrl = task.repoUrl.length > 0;
  const linked =
    options.rewriteLinks && hasUrl
      ? rewriteRelativeLinks(task.body, { taskDir: task.dir, repoUrl: task.repoUrl, branch: task.branch })
      : task.body;
  const extracted = extractChecklists(linked);
  const checklists = extracted.checklists;
  // Шапка описания: строка Q41 (описание — зеркало файла) и «Суть» для людей
  // первым блоком — фаундер и менеджер читают её, не разбирая остальное.
  const head = [
    '_Текст обновляется автоматически из репозитория. Правки — комментарием._',
    '',
    ...(task.summary && options.summaryInDescription !== false ? [`**Суть.** ${task.summary}`, '', '---', ''] : []),
  ].join('\n');
  const body = `${head}${extracted.body.replace(/^\s+/, '')}`;

  const sourcePath = task.sourceFile ?? task.dir;
  const sourceKind = task.sourceFile ? 'blob' : 'tree';
  const source = hasUrl
    ? `[\`${sourcePath}\`](${task.repoUrl.replace(/\/+$/, '')}/${sourceKind}/${task.branch}/${sourcePath})`
    : `\`${sourcePath}\``;
  const tail = [
    '',
    '---',
    '',
    `Источник: ${task.repoName} · ${source}`,
    task.hasLog ? `Журнал работы: \`${task.dir}/LOG.md\` (в карточку не переносится)` : null,
    task.attachments.length > 0 ? `Вложения в git (${task.attachments.length}): ${task.attachments.join(', ')}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const withoutMarker = `${body.trimEnd()}\n${tail}\n`;
  const hash = fingerprint({ title: task.title, status: task.status, description: withoutMarker, checklists });
  return { description: `${withoutMarker}\n<!-- acme-sync:${hash} -->\n`, checklists };
}

export function missingChecklists(wanted: Checklist[], existing: ExistingChecklist[]): ChecklistPatch[] {
  const out: ChecklistPatch[] = [];
  for (const list of wanted) {
    const found = existing.find((e) => e.name === list.name);
    // Пилот 24.09.2026 создал чек-листы без префикса — их переименовываем.
    const legacy = found ? undefined : existing.find((e) => e.name === withoutAgentPrefix(list.name));
    const target = found ?? legacy;
    if (!target) {
      out.push(list);
      continue;
    }
    const have = new Set(target.itemTexts);
    const items = list.items.filter((i) => !have.has(i.text));
    if (items.length > 0 || legacy) out.push({ name: list.name, items, checklistId: target.id, ...(legacy ? { rename: true } : {}) });
  }
  return out;
}

/** Значение поля «Репозиторий» для задачи; `undefined` — репозитория нет среди вариантов. */
export function repoValue(task: TaskFile, mapping: BoardMapping): unknown {
  const prop = mapping.repoProperty;
  if (!prop) return undefined;
  if (!prop.values) return task.repoName;
  const id = prop.values[task.repoName];
  return id === undefined ? undefined : [id];
}

/** id варианта «Команды» для задачи: своя команда задачи, иначе команда по умолчанию. */
export function teamValueId(task: TaskFile, mapping: BoardMapping): number | undefined {
  const name = task.team ?? mapping.defaultTeam;
  return name && mapping.teamProperty ? mapping.teamProperty.values[name] : undefined;
}

function buildPayload(task: TaskFile, mapping: BoardMapping, description: string): CardPayload {
  const payload: CardPayload = {
    title: task.title,
    board_id: mapping.boardId,
    external_id: task.externalId,
    description,
    text_format_type_id: 1,
  };
  const columnId = mapping.columns[task.status];
  if (columnId !== undefined) payload.column_id = columnId;
  if (mapping.laneId !== undefined) payload.lane_id = mapping.laneId;
  const typeId = mapping.types?.[task.meta.type];
  if (typeId !== undefined) payload.type_id = typeId;

  const properties: Record<string, unknown> = {};
  if (mapping.priorityProperty && task.meta.priority !== null) {
    const value = mapping.priorityProperty.values[task.meta.priority];
    // Селект: API ждёт массив id вариантов — `id_6: [12]` (документация cards/create-new-card).
    if (value !== undefined) properties[`id_${mapping.priorityProperty.id}`] = [value];
  }
  const repo = repoValue(task, mapping);
  if (mapping.repoProperty && repo !== undefined) properties[`id_${mapping.repoProperty.id}`] = repo;
  const team = teamValueId(task, mapping);
  if (mapping.teamProperty && team !== undefined) properties[`id_${mapping.teamProperty.id}`] = [team];
  if (mapping.summaryProperty && task.summary) properties[`id_${mapping.summaryProperty.id}`] = task.summary;
  if (Object.keys(properties).length > 0) payload.properties = properties;

  return payload;
}

export interface BuildPlanInput {
  tasks: TaskFile[];
  existing: Map<string, ExistingCard>;
  mapping: BoardMapping;
  render: RenderOptions;
  /** Планировать ли связи «эпик → story». */
  linkEpics: boolean;
}

export function buildPlan(input: BuildPlanInput): ImportPlan {
  const { tasks, existing, mapping, render } = input;
  const actions: PlanAction[] = [];
  const warnings: PlanWarning[] = [];

  // Эпики первыми: карточка родителя должна существовать раньше связи.
  const ordered = [...tasks].sort((a, b) => {
    const rank = (t: TaskFile): number => (t.meta.type === 'epic' ? 0 : 1);
    return rank(a) - rank(b) || a.externalId.localeCompare(b.externalId);
  });

  const selected = new Set(ordered.map((t) => t.externalId));

  for (const task of ordered) {
    const { description, checklists } = renderCard(task, render);
    const payload = buildPayload(task, mapping, description);
    const card = existing.get(task.externalId);

    if (mapping.columns[task.status] === undefined) {
      warnings.push({ externalId: task.externalId, detail: `нет колонки под статус «${task.status}»` });
    }
    const repo = repoValue(task, mapping);
    if (mapping.repoProperty && repo === undefined) {
      warnings.push({ externalId: task.externalId, detail: `репозитория «${task.repoName}» нет среди вариантов поля — добавьте в setup.repos` });
    }

    if (!card) {
      actions.push({ kind: 'create', externalId: task.externalId, title: task.title, payload, task, checklists });
      continue;
    }

    // Недостающие чек-листы существующей карточки — по имени; имеющиеся не трогаем.
    if (checklists.length > 0) {
      if (card.checklists === undefined) {
        warnings.push({ externalId: task.externalId, detail: 'чек-листы карточки не прочитаны — пункты не перенесены' });
      } else {
        const missing = missingChecklists(checklists, card.checklists);
        if (missing.length > 0) actions.push({ kind: 'checklists', externalId: task.externalId, cardId: card.id, checklists: missing });
      }
    }

    const reasons: string[] = [];
    const patch: Partial<CardPayload> = {};

    if (card.title !== undefined && card.title !== task.title) {
      reasons.push('заголовок');
      patch.title = task.title;
    }
    // «Репозиторий» — поле файла, обновляется и у существующих карточек.
    // Приоритет, тип и команда — поля Kaiten: только при создании.
    if (mapping.repoProperty && repo !== undefined && card.properties !== undefined) {
      const key = `id_${mapping.repoProperty.id}`;
      if (JSON.stringify(card.properties[key] ?? null) !== JSON.stringify(repo)) {
        reasons.push('репозиторий');
        patch.properties = { ...patch.properties, [key]: repo };
      }
    }
    // «Суть» — поле файла, как «Репозиторий»: обновляется всегда.
    if (mapping.summaryProperty && task.summary && card.properties !== undefined) {
      const key = `id_${mapping.summaryProperty.id}`;
      if (card.properties[key] !== task.summary) {
        reasons.push('суть');
        patch.properties = { ...patch.properties, [key]: task.summary };
      }
    }
    // «Команда» — поле Kaiten: только заполняем пустое, выбор человека не трогаем.
    if (mapping.teamProperty && card.properties !== undefined) {
      const key = `id_${mapping.teamProperty.id}`;
      const team = teamValueId(task, mapping);
      const current = card.properties[key];
      if (team !== undefined && (current === undefined || current === null || (Array.isArray(current) && current.length === 0))) {
        reasons.push('команда не заполнена');
        patch.properties = { ...patch.properties, [key]: [team] };
      }
    }
    // Колонку ставим только при создании. Дальше статусом владеет Kaiten
    // (inbox/backlog/ready/cancelled — Q30) или интеграция с GitHub
    // (in-progress/review/done): проверено живьём, что карточку двигают в
    // интерфейсе, и повторная заливка тащила бы её обратно.

    const wanted = readFingerprint(description);
    const actual = readFingerprint(card.description);
    if (card.description === undefined) {
      reasons.push('описание карточки не прочитано');
      patch.description = description;
      patch.text_format_type_id = 1;
    } else if (wanted !== actual) {
      reasons.push('тело задачи');
      patch.description = description;
      patch.text_format_type_id = 1;
    }

    if (reasons.length === 0) {
      actions.push({ kind: 'unchanged', externalId: task.externalId, cardId: card.id });
      continue;
    }
    actions.push({ kind: 'update', externalId: task.externalId, cardId: card.id, payload: patch, reasons, task });
  }

  if (input.linkEpics) {
    for (const task of ordered) {
      const parent = task.parentExternalId;
      if (!parent) continue;
      if (!selected.has(parent)) {
        warnings.push({
          externalId: task.externalId,
          detail: `родитель ${parent} вне выборки — карточка уедет без связи`,
        });
        continue;
      }
      const childCard = existing.get(task.externalId);
      const parentCard = existing.get(parent);
      // Связь уже есть — второй POST /children не нужен (проверено живьём:
      // без этой проверки каждый повтор планировал связь заново).
      if (childCard && parentCard && (childCard.parentIds?.includes(parentCard.id) || parentCard.childIds?.includes(childCard.id))) continue;
      actions.push({
        kind: 'link',
        childExternalId: task.externalId,
        parentExternalId: parent,
        childCardId: childCard?.id ?? null,
        parentCardId: parentCard?.id ?? null,
      });
    }
  }

  const stats = {
    create: actions.filter((a) => a.kind === 'create').length,
    update: actions.filter((a) => a.kind === 'update').length,
    unchanged: actions.filter((a) => a.kind === 'unchanged').length,
    link: actions.filter((a) => a.kind === 'link').length,
    checklists: actions.filter((a) => a.kind === 'checklists').length,
  };

  return { actions, warnings, stats };
}
