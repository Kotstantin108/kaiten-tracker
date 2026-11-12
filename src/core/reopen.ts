/**
 * Возврат отменённых задач во «Входящие» — чистая часть скрипта владельца
 * (`src/reopen.ts`): какие задачи отменены записью журнала с таким текстом.
 *
 * ЗАЧЕМ. Отмена — закрытый статус: `kaiten start` на такой задаче отказывает, а
 * команды, которая её возвращает, у агента нет намеренно — отмену решает
 * человек, и снимает её тоже он. 12.11.2026 разбор старых задач агентов отменил
 * пачкой поставленную работу (story и tech с критериями): вернуть её было нечем.
 * Пачку находит запись журнала — у всех задач одного прогона причина начинается
 * одинаково.
 */

import type { TaskRecord } from './tasks-index.js';

export interface Cancellation {
  task: TaskRecord;
  /** Дата отмены `YYYY-MM-DD` — из записи журнала. */
  date: string;
  /** Время записи как в журнале; у записей до 19.10.2026 — только дата. */
  stamp: string;
  /** Кто отменил; у старых записей автора нет. */
  by: string | null;
  /** Причина: текст записи после «отменена:», вместе с её продолжением. */
  reason: string;
}

const ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2})([^\]·]*)(?:·\s*([^\]]+))?\][ \t]*(.*)$/;
const CANCEL_RE = /^отменена:\s*(.*)$/;

/** Последняя запись об отмене в журнале задачи; `null` — такой записи нет (отменили в Kaiten). */
export function lastCancellation(log: string | null): Omit<Cancellation, 'task'> | null {
  const lines = (log ?? '').split('\n');
  let found: Omit<Cancellation, 'task'> | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const entry = ENTRY_RE.exec(lines[i]);
    if (!entry) continue;
    const cancel = CANCEL_RE.exec(entry[4].trim());
    if (!cancel) continue;
    const rest: string[] = [];
    for (let j = i + 1; j < lines.length && !ENTRY_RE.test(lines[j]); j += 1) rest.push(lines[j]);
    found = {
      date: entry[1],
      stamp: `${entry[1]}${entry[2]}`.trim(),
      by: entry[3]?.trim() || null,
      reason: [cancel[1], ...rest].join('\n').trim(),
    };
  }
  return found;
}

export interface CancelledFilter {
  /** Текст в причине отмены (регистр и «ё» не важны); нет — любая причина. */
  text?: string;
  /** Отменены не раньше этого дня и не позже этого, `YYYY-MM-DD`. */
  since?: string;
  until?: string;
}

const fold = (text: string): string => text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/**
 * Отменённые задачи, чья отмена записана в журнале и подходит под отбор, —
 * по дате отмены. Отменённые переносом карточки в Kaiten (записи в журнале
 * нет) сюда не попадают: их отменял человек, и причины мы не знаем.
 */
export function findCancelled(tasks: readonly TaskRecord[], filter: CancelledFilter = {}): Cancellation[] {
  const wanted = filter.text ? fold(filter.text) : null;
  const out: Cancellation[] = [];
  for (const task of tasks) {
    if (task.fm.status !== 'cancelled') continue;
    const last = lastCancellation(task.log);
    if (!last) continue;
    if (wanted !== null && !fold(last.reason).includes(wanted)) continue;
    if (filter.since && last.date < filter.since) continue;
    if (filter.until && last.date > filter.until) continue;
    out.push({ task, ...last });
  }
  return out.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.task.slug.localeCompare(b.task.slug));
}

/** Запись в журнал задачи о возврате. */
export function reopenNote(reason: string): string {
  return `возвращена во «Входящие»: ${reason.trim()}`;
}
