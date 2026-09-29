/**
 * `kaiten start` — чистая часть: можно ли взять задачу в работу и как
 * назвать ветку.
 *
 * СТАТУСЫ В РАБОТУ ДВИГАЕТ НЕ CLI (решение 5, Q30): карточку в «В работе»
 * переносит интеграция Kaiten ↔ GitHub, когда ветка с id карточки появляется
 * на GitHub; PR → «Ревью», merge → «Сделано». CLI только заводит ветку с
 * ключом. Поэтому проверки повторяют ограничения доски (28.09): в «В работе»
 * — только из «Готово к работе» и «Заблокировано» (и обратно из «Ревью»), и
 * ветка задачи из «Бэклога» интеграцию не сдвинула бы — лучше сказать сразу.
 *
 * ИМЯ ВЕТКИ. Q24 называл ветку по эпику; решение 7 (эпик → задача = один PR)
 * и PROMPT сильнее: ветка — по задаче, `feature/<id карточки>-<slug>`.
 * Интеграция ищет в имени ветки числовой id карточки где угодно («как
 * называть ветку — неважно, главное, чтобы там был ID карточки», FAQ Kaiten
 * «GitHub», 29.09) — поэтому части slug с цифрами выбрасываются: в имени
 * ровно одно число, и «…-posle-503» не сдвинет карточку 503. Коммит
 * связывается с карточкой по `#<id>` в сообщении.
 */

import type { TaskStatus } from './schema.js';
import { refOf, type TaskRecord } from './tasks-index.js';

/** Из этих статусов задачу берут в работу; из последних двух — продолжают. */
export const STARTABLE: readonly TaskStatus[] = ['ready', 'blocked', 'in-progress', 'review'];

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

/** Число из ключа карточки, которое интеграция найдёт в ветке; `null` — ключа нет или он не числовой. */
export function cardNumber(task: TaskRecord): string | null {
  return task.fm.tracker !== undefined && /^\d+$/.test(task.fm.tracker) ? task.fm.tracker : null;
}

export function branchName(cardId: string, slug: string): string {
  const words = slug.split('-').filter((w) => w !== '' && !/\d/.test(w));
  return `feature/${cardId}${words.length > 0 ? `-${words.join('-')}` : ''}`;
}

/** Что мешает взять задачу в работу из этого репозитория — словами задачи; `null` — ничего. */
export function startProblem(task: TaskRecord, currentRepo: string): string | null {
  if (task.fm.type === 'epic') return `это эпик: в работу берут его задачи — kaiten list --epic ${refOf(task)}`;
  if (task.fm.status === 'done' || task.fm.status === 'cancelled') return `задача уже в ${STATUS_WORDS[task.fm.status]}`;
  if (!STARTABLE.includes(task.fm.status)) {
    return `задача во ${STATUS_WORDS[task.fm.status]}: в работу берут из «Готово к работе» — её переводят туда в Kaiten при разборе`;
  }
  if (task.fm.repo !== currentRepo) return `задача для репозитория ${task.fm.repo ?? '(не указан)'}, а вы в ${currentRepo}`;
  if (task.fm.tracker === undefined) return 'у задачи ещё нет карточки в Kaiten — повторите после kaiten pull';
  if (cardNumber(task) === null) return `ключ ${task.fm.tracker} без номера карточки — ветку по нему Kaiten не узнает`;
  return null;
}
