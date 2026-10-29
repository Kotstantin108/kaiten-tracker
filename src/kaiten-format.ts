/**
 * Текстовый и JSON-вывод команд чтения CLI `kaiten`. Чистый модуль: читает
 * агент, поэтому формат устойчивый — строка на задачу, ключ первым столбцом,
 * чтобы его можно было сразу передать в `kaiten show`.
 */

import { juniorMissingText, type JuniorReadiness } from './core/junior.js';
import { checklistProgress, childrenOf, epicOf, refOf, slugOf, type SearchHit, type TaskProblem, type TaskRecord } from './core/tasks-index.js';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function epicProgress(all: readonly TaskRecord[], epic: TaskRecord): string {
  const children = childrenOf(all, epic);
  if (children.length === 0) return ' · задач нет';
  return ` · закрыто ${children.filter((c) => c.closed).length} из ${children.length}`;
}

/** Строки списка: ключ, статус, приоритет, тип, [репозиторий], заголовок. */
export function formatTaskLines(all: readonly TaskRecord[], tasks: readonly TaskRecord[], withRepo: boolean): string[] {
  const refWidth = Math.max(0, ...tasks.map((t) => refOf(t).length));
  const repoWidth = Math.max(0, ...tasks.map((t) => (t.fm.repo ?? '—').length));
  return tasks.map((t) => {
    const cols = [pad(refOf(t), refWidth), pad(t.fm.status, 11), pad(t.fm.priority ?? '—', 2), pad(t.fm.type, 5)];
    if (withRepo) cols.push(pad(t.fm.repo ?? '—', repoWidth));
    // У задачи в работе и на ревью — её ветка: работа ещё не в main, но видна отсюда.
    const working = (t.fm.status === 'in-progress' || t.fm.status === 'review') && t.fm.branch ? ` · ветка ${t.fm.branch}` : '';
    const tail = t.fm.type === 'epic' ? epicProgress(all, t) : working;
    return `${cols.join('  ')}  ${t.fm.title}${tail}`;
  });
}

export function formatSearch(all: readonly TaskRecord[], hits: readonly SearchHit[], withRepo: boolean): string[] {
  const lines = formatTaskLines(
    all,
    hits.map((h) => h.task),
    withRepo,
  );
  const cut = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max - 3)}…` : text);
  return hits.flatMap((hit, i) => {
    if (hit.lines) {
      // Совпавшая строка — «▸», соседняя — «·»; разрыв между кусками — «--».
      const withContext = hit.lines.some((l) => !l.hit);
      const shown = hit.lines.flatMap((l, n) => [
        ...(withContext && l.gap && n > 0 ? ['    --'] : []),
        `    ${l.where} ${l.hit ? '▸' : '·'} ${cut(presentBody(all, l.text), 200)}`,
      ]);
      return [lines[i], ...shown];
    }
    return hit.snippet ? [lines[i], `    … ${cut(presentBody(all, hit.snippet))}`] : [lines[i]];
  });
}

// ── части задачи ─────────────────────────────────────────────────────────

const PART_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const PART_FENCE_RE = /^\s*(```|~~~)/;
const PART_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+\S/;

export interface BodySection {
  level: number;
  name: string;
  /** Строки раздела без заголовка — до следующего заголовка любого уровня. */
  lines: string[];
}

/** Тело по заголовкам; текст до первого заголовка — раздел без имени. Заголовки в блоках кода не считаются. */
export function bodySections(body: string): BodySection[] {
  const sections: BodySection[] = [{ level: 0, name: '', lines: [] }];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (PART_FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : PART_HEADING_RE.exec(line);
    if (m) sections.push({ level: m[1].length, name: m[2].replace(/[*_`]/g, '').trim(), lines: [] });
    else sections.at(-1)?.lines.push(line);
  }
  return sections.filter((s) => s.name !== '' || s.lines.some((l) => l.trim() !== ''));
}

function headLine(task: TaskRecord): string {
  return `${refOf(task)} · ${task.fm.status} · ${task.fm.title}`;
}

/** Записи журнала: каждая начинается с `## [дата]`. */
export function logEntries(log: string | null): string[] {
  return (log ?? '')
    .split(/^(?=## \[)/m)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Оглавление задачи: разделы с числом строк и пунктов, журнал, вложения. */
export function formatOutline(task: TaskRecord, attachments: readonly string[]): string {
  const out = [headLine(task), ''];
  for (const s of bodySections(task.body)) {
    const items = s.lines.filter((l) => PART_ITEM_RE.test(l));
    const done = items.filter((l) => /\[[xX]\]/.test(l)).length;
    const size = s.lines.filter((l) => l.trim() !== '').length;
    const name = s.name === '' ? '(до первого заголовка)' : `${'#'.repeat(s.level)} ${s.name}`;
    out.push(`${name} — строк ${size}${items.length > 0 ? `, пунктов ${done}/${items.length}` : ''}`);
  }
  const entries = logEntries(task.log);
  if (entries.length > 0) out.push('', `Журнал: записей ${entries.length}, последняя — ${entries.at(-1)?.split('\n')[0].replace(/^## /, '')}`);
  if (attachments.length > 0) out.push(`Вложения (${attachments.length}): ${attachments.join(', ')}`);
  out.push('', `Раздел целиком: kaiten show ${refOf(task)} --section "<название>"`);
  return `${out.join('\n')}\n`;
}

/**
 * Разделы, в названии которых есть эти слова, — с вложенными подразделами.
 * `null` — такого раздела нет.
 */
export function formatSection(all: readonly TaskRecord[], task: TaskRecord, query: string): string | null {
  const sections = bodySections(task.body);
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  const out: string[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    if (s.name === '' || !s.name.toLowerCase().replace(/ё/g, 'е').includes(q)) continue;
    const part = [`${'#'.repeat(s.level)} ${s.name}`, ...s.lines];
    let j = i + 1;
    for (; j < sections.length && sections[j].level > s.level; j += 1) part.push(`${'#'.repeat(sections[j].level)} ${sections[j].name}`, ...sections[j].lines);
    // Подразделы уже показаны — отдельно их не повторяем.
    i = j - 1;
    out.push(part.join('\n').trim());
  }
  if (out.length === 0) return null;
  return `${headLine(task)}\n\n${presentBody(all, out.join('\n\n'))}\n`;
}

/** Неотмеченные пункты по разделам. */
export function formatTodo(all: readonly TaskRecord[], task: TaskRecord): string {
  const out = [headLine(task), ''];
  let total = 0;
  for (const s of bodySections(task.body)) {
    const open = s.lines.filter((l) => PART_ITEM_RE.test(l) && /\[ \]/.test(l));
    if (open.length === 0) continue;
    total += open.length;
    out.push(s.name === '' ? 'Без раздела:' : `${s.name}:`, ...open.map((l) => `  ${presentBody(all, l.trim())}`), '');
  }
  if (total === 0) out.push(checklistProgress(task.body).length > 0 ? 'Все пункты отмечены.' : 'В задаче нет пунктов.', '');
  return `${out.join('\n').trimEnd()}\n`;
}

/** Последние записи журнала. */
export function formatLogTail(all: readonly TaskRecord[], task: TaskRecord, count: number, attachments: readonly string[] = []): string {
  const entries = logEntries(task.log);
  // Передача дел лежит во вложениях — тому, кто продолжает задачу, они нужны вместе с журналом.
  const files = attachments.length > 0 ? `\nВложения (${attachments.length}): ${attachments.join(', ')} — kaiten files ${refOf(task)} <файл>\n` : '';
  if (entries.length === 0) return `${headLine(task)}\n\nЖурнал пуст.\n${files}`;
  const shown = entries.slice(-count);
  const note = shown.length < entries.length ? ` (последние ${shown.length} из ${entries.length})` : ` (${entries.length})`;
  return `${headLine(task)}\n\nЖурнал${note}:\n\n${presentBody(all, shown.join('\n\n'))}\n${files}`;
}

/** Счёт пунктов одной строкой — как в `kaiten show`. */
export function progressLine(task: TaskRecord): string | null {
  const progress = checklistProgress(task.body);
  return progress.length > 0 ? `Пункты: ${progress.map((p) => `${p.name} ${p.done}/${p.total}`).join(' · ')}` : null;
}

/**
 * Ссылки тела на другие задачи (`/active/<slug>.md`, `/archive/…`) и на
 * вложения (`/attachments/<slug>/<файл>`) ведут в репозиторий задач, которого
 * у читателя нет. Показываем их командами: так агенту есть куда идти, и
 * расположение задач нигде не всплывает.
 */
export function presentBody(all: readonly TaskRecord[], body: string): string {
  const refBySlug = new Map(all.map((t) => [t.slug, refOf(t)]));
  return body
    .replace(/\]\(\/(?:active|archive\/\d{4}-\d{2})\/([a-z0-9-]+)\.md(?:#[^)]*)?\)/g, (_, slug: string) => `](kaiten show ${refBySlug.get(slug) ?? slug})`)
    .replace(/\]\(\/attachments\/([a-z0-9-]+)\/([^)\s]+)\)/g, (_, slug: string, file: string) => `](kaiten files ${refBySlug.get(slug) ?? slug} ${safeDecode(file)})`);
}

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/** Признак «Можно младшему» строкой — как в выводе `kaiten new`; `null` — к задаче не применим. */
export function juniorLine(readiness: JuniorReadiness): string | null {
  if (readiness === null) return null;
  return readiness.ok ? 'Младшему: да.' : `Младшему: нет — не хватает: ${juniorMissingText(readiness.missing)}.`;
}

/** `junior` — признак задачи, если проект отмечает задачи для младших. */
export function formatShow(all: readonly TaskRecord[], task: TaskRecord, attachments: readonly string[], junior: JuniorReadiness = null): string {
  const fm = task.fm;
  const out: string[] = [`# ${fm.title}`, ''];
  const facts = [refOf(task), fm.type, fm.status, fm.priority ? `приоритет ${fm.priority}` : 'без приоритета'];
  if (fm.repo) facts.push(fm.repo);
  if (fm.team) facts.push(fm.team);
  out.push(facts.join(' · '));
  if (fm.tracker) out.push(`slug: ${task.slug}`);

  const epic = epicOf(all, task);
  if (epic) out.push(`Эпик: ${refOf(epic)} — ${epic.fm.title}`);
  else if (fm.epic) out.push(`Эпик: ${fm.epic} (в задачах проекта не найден)`);

  const planning = fm.planning;
  const plan: string[] = [];
  if (planning?.assignee) plan.push(`исполнитель ${planning.assignee}`);
  if (planning?.delegated_to) plan.push(`делегировано ${planning.delegated_to}`);
  if (planning?.due) plan.push(`срок ${planning.due}`);
  if (planning?.estimate_days !== undefined && planning.estimate_days !== null) plan.push(`оценка ${planning.estimate_days} дн.`);
  if (planning?.phase) plan.push(`фаза ${planning.phase}`);
  if (plan.length > 0) out.push(`План: ${plan.join(' · ')}`);
  if (fm.related && fm.related.length > 0) out.push(`Связано: ${fm.related.join(', ')}`);
  if (fm.branch) out.push(`Ветка: ${fm.branch}`);
  out.push(`Создана ${fm.created}, ${fm.created_by}; обновлена ${fm.updated}`);

  const progress = checklistProgress(task.body);
  if (progress.length > 0) out.push(`Пункты: ${progress.map((p) => `${p.name} ${p.done}/${p.total}`).join(' · ')}`);
  const juniorText = juniorLine(junior);
  if (juniorText) out.push(juniorText);
  if (attachments.length > 0) out.push(`Вложения (${attachments.length}): kaiten files ${refOf(task)}`);
  out.push('', `Суть: ${fm.summary}`, '', presentBody(all, task.body).trim());

  if (task.log?.trim()) out.push('', '## Журнал', '', presentBody(all, task.log).trim());

  if (fm.type === 'epic') {
    const children = childrenOf(all, task);
    out.push('', `## Задачи эпика (${children.length})`, '');
    out.push(...(children.length > 0 ? formatTaskLines(all, children, true) : ['Задач пока нет.']));
  } else if (epic) {
    const siblings = childrenOf(all, epic).filter((t) => t !== task);
    if (siblings.length > 0) out.push('', `## Другие задачи эпика (${siblings.length})`, '', ...formatTaskLines(all, siblings, true));
  }
  return `${out.join('\n')}\n`;
}

export interface TaskJson {
  ref: string;
  id: string;
  tracker: string | null;
  slug: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  priority: string | null;
  repo: string | null;
  epic: string | null;
  branch: string | null;
}

export function taskJson(all: readonly TaskRecord[], task: TaskRecord): TaskJson {
  const epic = epicOf(all, task);
  return {
    ref: refOf(task),
    id: task.fm.id,
    tracker: task.fm.tracker ?? null,
    slug: task.slug,
    title: task.fm.title,
    summary: task.fm.summary,
    type: task.fm.type,
    status: task.fm.status,
    priority: task.fm.priority ?? null,
    repo: task.fm.repo ?? null,
    epic: epic ? refOf(epic) : (task.fm.epic ?? null),
    branch: task.fm.branch ?? null,
  };
}

/** Нечитаемые задачи — по slug: его же принимает `kaiten show`; путей файлов вывод не показывает. */
export function formatProblems(problems: readonly TaskProblem[]): string[] {
  if (problems.length === 0) return [];
  const shown = problems.slice(0, 5).map((p) => `  ${slugOf(p.path)}: ${p.message}`);
  const more = problems.length > shown.length ? [`  …и ещё ${problems.length - shown.length}`] : [];
  return ['', `Не читается задач: ${problems.length}. Что исправить:`, ...shown, ...more];
}

/** `junior` — признак задачи; не передан — проект задачи для младших не отмечает, ключа нет. */
export function showJson(all: readonly TaskRecord[], task: TaskRecord, attachments: readonly string[], junior?: JuniorReadiness): object {
  const epic = epicOf(all, task);
  const group = task.fm.type === 'epic' ? childrenOf(all, task) : epic ? childrenOf(all, epic).filter((t) => t !== task) : [];
  return {
    ...taskJson(all, task),
    ...(junior !== undefined ? { junior } : {}),
    frontmatter: task.fm,
    body: presentBody(all, task.body),
    log: task.log === null ? null : presentBody(all, task.log),
    checklists: checklistProgress(task.body),
    attachments,
    [task.fm.type === 'epic' ? 'children' : 'siblings']: group.map((t) => taskJson(all, t)),
  };
}
