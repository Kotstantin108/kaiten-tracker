/**
 * Текстовый и JSON-вывод команд чтения CLI `kaiten`. Чистый модуль: читает
 * агент, поэтому формат устойчивый — строка на задачу, ключ первым столбцом,
 * чтобы его можно было сразу передать в `kaiten show`.
 */

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
    const tail = t.fm.type === 'epic' ? epicProgress(all, t) : '';
    return `${cols.join('  ')}  ${t.fm.title}${tail}`;
  });
}

export function formatSearch(all: readonly TaskRecord[], hits: readonly SearchHit[], withRepo: boolean): string[] {
  const lines = formatTaskLines(
    all,
    hits.map((h) => h.task),
    withRepo,
  );
  const cut = (text: string): string => (text.length > 140 ? `${text.slice(0, 137)}…` : text);
  return hits.flatMap((hit, i) => (hit.snippet ? [lines[i], `    … ${cut(presentBody(all, hit.snippet))}`] : [lines[i]]));
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

export function formatShow(all: readonly TaskRecord[], task: TaskRecord, attachments: readonly string[]): string {
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
  out.push(`Создана ${fm.created}, ${fm.created_by}; обновлена ${fm.updated}`);

  const progress = checklistProgress(task.body);
  if (progress.length > 0) out.push(`Пункты: ${progress.map((p) => `${p.name} ${p.done}/${p.total}`).join(' · ')}`);
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
  };
}

/** Нечитаемые задачи — по slug: его же принимает `kaiten show`; путей файлов вывод не показывает. */
export function formatProblems(problems: readonly TaskProblem[]): string[] {
  if (problems.length === 0) return [];
  const shown = problems.slice(0, 5).map((p) => `  ${slugOf(p.path)}: ${p.message}`);
  const more = problems.length > shown.length ? [`  …и ещё ${problems.length - shown.length}`] : [];
  return ['', `Не читается задач: ${problems.length}. Что исправить:`, ...shown, ...more];
}

export function showJson(all: readonly TaskRecord[], task: TaskRecord, attachments: readonly string[]): object {
  const epic = epicOf(all, task);
  const group = task.fm.type === 'epic' ? childrenOf(all, task) : epic ? childrenOf(all, epic).filter((t) => t !== task) : [];
  return {
    ...taskJson(all, task),
    frontmatter: task.fm,
    body: presentBody(all, task.body),
    log: task.log === null ? null : presentBody(all, task.log),
    checklists: checklistProgress(task.body),
    attachments,
    [task.fm.type === 'epic' ? 'children' : 'siblings']: group.map((t) => taskJson(all, t)),
  };
}
