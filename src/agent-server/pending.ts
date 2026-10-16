/**
 * Ожидающие подтверждения человека: одноразовая ссылка на 30 минут.
 *
 * Три вида — правка документа (`docs.ts`), комментарий, который уйдёт
 * гостю или заказчику, и загрузка файла со страницы. Запись хранится
 * зашифрованной и привязана к человеку: подтверждает только тот, кто просил.
 * У записей до появления видов поля `kind` нет — это правка документа.
 */

import { z } from 'zod';

import { openData, sealData } from './key.js';
import type { Store } from './store.js';

export const PENDING_TTL = 30 * 60;

const Base = { userId: z.number(), agentKey: z.string(), by: z.string() };

export const CommentPendingSchema = z.object({
  ...Base,
  kind: z.literal('comment'),
  cardId: z.number(),
  cardTitle: z.string(),
  boardTitle: z.string(),
  /** Почему нужно подтверждение — человеку на странице. */
  reason: z.string(),
  text: z.string(),
});
export type CommentPending = z.infer<typeof CommentPendingSchema>;

export const UploadPendingSchema = z.object({
  ...Base,
  kind: z.literal('upload'),
  cardId: z.number(),
  cardUid: z.string(),
  cardTitle: z.string(),
});
export type UploadPending = z.infer<typeof UploadPendingSchema>;

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const PENDING_ID = /^[A-Za-z0-9_-]{10,64}$/;

export async function savePending(store: Store, secret: string, value: unknown): Promise<string> {
  const id = randomId();
  await store.put(`pending:${id}`, await sealData(value, secret), PENDING_TTL);
  return id;
}

/** Расшифрованная запись как есть; вид разбирает тот, кто её читает. */
export async function readPending(store: Store, secret: string, id: string): Promise<unknown> {
  if (!PENDING_ID.test(id)) return null;
  const sealed = await store.get(`pending:${id}`);
  return sealed ? openData(sealed, secret) : null;
}

export async function dropPending(store: Store, id: string): Promise<void> {
  await store.delete(`pending:${id}`);
}

/** Вид записи: без `kind` — правка документа. */
export function pendingKind(raw: unknown): 'doc' | 'comment' | 'upload' | null {
  if (raw === null || typeof raw !== 'object') return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === undefined || kind === 'doc') return 'doc';
  return kind === 'comment' || kind === 'upload' ? kind : null;
}
