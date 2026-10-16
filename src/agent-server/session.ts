/**
 * Вход человека на сервер в браузере — для страниц подтверждения.
 *
 * Куки ставится, когда человек сам вводит токен Kaiten: на странице ключа,
 * при подключении по OAuth или на странице входа. Ключ агента входом не
 * считается: у агента есть ключ, но нет токена. Оговорка: агент, который
 * управляет браузером человека, этот куки получит вместе с браузером.
 *
 * SameSite=Lax: ссылка из чата открывается уже вошедшим (Strict бы не
 * передал куки при переходе с другого сайта), а форма подтверждения
 * дополнительно защищена своим токеном CSRF.
 */

import { sign, verify } from './key.js';

export const SESSION_COOKIE = '__Host-kaiten-agent';
const TTL_MS = 30 * 86400 * 1000;

export async function makeSession(userId: number, secret: string, now = Date.now()): Promise<string> {
  const expires = (now + TTL_MS).toString(36);
  return `${userId}.${expires}.${await sign('session', `${userId}|${expires}`, secret)}`;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`;
}

/** Значение куки сессии из заголовка Cookie. */
export function sessionValue(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export async function readSession(value: string | null, secret: string, now = Date.now()): Promise<{ userId: number } | null> {
  const [id, expires, signature] = (value ?? '').split('.');
  const userId = Number(id);
  if (!Number.isInteger(userId) || !expires || !signature) return null;
  if (!(await verify('session', `${userId}|${expires}`, signature, secret))) return null;
  return parseInt(expires, 36) > now ? { userId } : null;
}

/** Токен формы подтверждения: привязан к сессии и к конкретному подтверждению. */
export const csrfToken = (session: string, pendingId: string, secret: string): Promise<string> => sign('csrf', `${session}|${pendingId}`, secret);

export const checkCsrf = (session: string, pendingId: string, token: string, secret: string): Promise<boolean> => verify('csrf', `${session}|${pendingId}`, token, secret);
