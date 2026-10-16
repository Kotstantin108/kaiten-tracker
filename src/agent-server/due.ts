/**
 * Срок карточки при создании: дата без времени и «+N рабочих дней».
 *
 * Рабочие дни — понедельник–пятница, без праздников: производственных
 * календарей в Kaiten у компании нет (живьём 16.10.2026 список пуст). «Сегодня»
 * — по часовому поясу пользователя из Kaiten, иначе UTC.
 */

/** Сегодня в часовом поясе, `YYYY-MM-DD`. Незнакомый пояс — UTC. */
export function todayIn(timeZone: string | null | undefined, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Настоящая ли это дата `YYYY-MM-DD` (не 2026-02-30). */
export function isDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** `from` плюс `days` рабочих дней (пн–пт); сам `from` не считается. */
export function addWorkingDays(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}

/** «рабочий день» по-русски для числа. */
export function workingDaysText(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 14 ? 'рабочих дней' : n % 10 === 1 ? 'рабочий день' : n % 10 >= 2 && n % 10 <= 4 ? 'рабочих дня' : 'рабочих дней';
  return `${n} ${tail}`;
}
