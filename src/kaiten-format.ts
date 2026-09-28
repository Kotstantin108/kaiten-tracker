/**
 * Текстовый и JSON-вывод команд чтения CLI `kaiten`. Чистый модуль: читает
 * агент, поэтому формат устойчивый — строка на задачу, ключ первым столбцом,
 * чтобы его можно было сразу передать в `kaiten show`.
 */

import { checklistProgress, childrenOf, epicOf, refOf, type SearchHit, type TaskRecord } from './core/tasks-index.js';

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
  return hits.flatMap((hit, i) => (hit.snippet ? [lines[i], `    … ${hit.snippet}`] : [lines[i]]));
}

export function formatShow(all: readonly TaskRecord[], task: TaskRecord, filePath: string): string {
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
  out.push(`Файл: ${filePath}`);
  out.push('', `Суть: ${fm.summary}`, '', task.body.trim());

  if (task.log?.trim()) out.push('', '## Журнал', '', task.log.trim());

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
  path: string;
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
    path: task.path,
  };
}

export function showJson(all: readonly TaskRecord[], task: TaskRecord): object {
  const epic = epicOf(all, task);
  const group = task.fm.type === 'epic' ? childrenOf(all, task) : epic ? childrenOf(all, epic).filter((t) => t !== task) : [];
  return {
    ...taskJson(all, task),
    frontmatter: task.fm,
    body: task.body,
    log: task.log,
    checklists: checklistProgress(task.body),
    [task.fm.type === 'epic' ? 'children' : 'siblings']: group.map((t) => taskJson(all, t)),
  };
}
