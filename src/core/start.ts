/**
 * `kaiten start` — чистая часть: можно ли взять задачу в работу и как
 * назвать ветку.
 *
 * Статус «В работе» ставит сама команда (владелец 29.09: интеграция
 * Kaiten ↔ GitHub не нужна — её пришлось бы подключать в каждом репозитории
 * кода, а в прод вливаем сами). Переход — как ограничение доски: из «Готово к
 * работе», «Заблокировано» или «Ревью» (`MOVES` в `task-ops.ts`); задачу,
 * которая уже в работе, команда продолжает.
 *
 * ИМЯ ВЕТКИ — `feature/<ключ карточки>-<slug>`, по задаче, а не по эпику
 * (решение 7 «эпик → задача = один PR» сильнее Q24). По ветке видно, чья это
 * работа, и повторный `start` на неё переключает. Карточки ещё нет
 * (синхронизация с Kaiten выключена) — `feature/<slug>`.
 */

import type { TaskStatus } from './schema.js';
import { ASSIGNABLE, moveProblem } from './task-ops.js';
import { refOf, type TaskRecord } from './tasks-index.js';

/** Из этих статусов задачу берут в работу; из «В работе» — продолжают. */
export const STARTABLE: readonly TaskStatus[] = ['ready', 'blocked', 'review', 'in-progress'];

const STATUS_WORDS: Record<TaskStatus, string> = {
  inbox: '«Входящих»',
  backlog: '«Бэклоге»',
  ready: '«Готово к работе»',
  'in-progress': '«В работе»',
  review: '«Ревью»',
  blocked: '«Заблокировано»',
  done: '«Сделано»',
  cancelled: '«Отменено»',
};

export function branchName(task: TaskRecord): string {
  return task.fm.tracker !== undefined ? `feature/${task.fm.tracker}-${task.slug}` : `feature/${task.slug}`;
}

/** Что мешает взять задачу в работу из этого репозитория — словами задачи; `null` — ничего. */
export function startProblem(task: TaskRecord, currentRepo: string, assigned = false): string | null {
  if (task.fm.type === 'epic') return `это эпик: в работу берут его задачи — kaiten list --epic ${refOf(task)}`;
  if (task.fm.status === 'done' || task.fm.status === 'cancelled') return `задача уже в ${STATUS_WORDS[task.fm.status]}`;
  // Прямое поручение человека на эту задачу — то же решение, что разбор (владелец 30.09, 05.10):
  // из «Входящих» и «Бэклога» можно.
  const allowed = STARTABLE.includes(task.fm.status) || (assigned && ASSIGNABLE.includes(task.fm.status));
  if (!allowed) {
    const how =
      ASSIGNABLE.includes(task.fm.status)
        ?'её переводят туда в Kaiten при разборе. Человек прямо поручил вам именно эту задачу — kaiten start ' + refOf(task) + ' --assigned'
        : 'её переводят туда в Kaiten при разборе';
    return `задача во ${STATUS_WORDS[task.fm.status]}: в работу берут из «Готово к работе» — ${how}`;
  }
  if (task.fm.repo !== currentRepo) return `задача для репозитория ${task.fm.repo ?? '(не указан)'}, а вы в ${currentRepo}`;
  return moveProblem(task, 'in-progress', assigned);
}
