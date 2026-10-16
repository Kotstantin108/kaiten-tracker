/**
 * Код предпросмотра: создание в два шага.
 *
 * Первый вызов возвращает предпросмотр и код — подпись сервера над
 * человеком, содержимым карточки и сроком. Запись — только вторым вызовом с
 * тем же содержимым и этим кодом. Изменилось хоть одно поле — код не подходит,
 * нужен новый предпросмотр. Повтор того же кода после записи упрётся в запрет
 * дублей: такая карточка уже открыта на доске.
 */

import { sign, verify } from './key.js';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PURPOSE = 'preview';

/** JSON с упорядоченными ключами: одно содержимое — одна строка. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function issueCode(payload: unknown, userId: number, secret: string, now = Date.now()): Promise<string> {
  const expires = now + PREVIEW_TTL_MS;
  return `${expires.toString(36)}.${await sign(PURPOSE, `${userId}|${expires}|${canonical(payload)}`, secret)}`;
}

export type CodeCheck = 'ok' | 'expired' | 'mismatch';

export async function checkCode(code: string, payload: unknown, userId: number, secret: string, now = Date.now()): Promise<CodeCheck> {
  const [stamp, signature] = code.trim().split('.');
  const expires = parseInt(stamp ?? '', 36);
  if (!signature || !Number.isFinite(expires)) return 'mismatch';
  if (!(await verify(PURPOSE, `${userId}|${expires}|${canonical(payload)}`, signature, secret))) return 'mismatch';
  return now > expires ? 'expired' : 'ok';
}
