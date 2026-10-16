/**
 * Подтверждённые человеком действия над карточкой: комментарий, который
 * уйдёт гостю или заказчику, и файл со страницы загрузки. Выполняются
 * ключом того, кто просил, через ту же заслонку, что и инструменты.
 */

import { KaitenApiError } from '../kaiten-client.js';
import { fileProblems, MAX_UPLOAD_BYTES } from './card-files.js';
import type { AgentKaiten } from './kaiten-agent.js';
import type { CommentPending, UploadPending } from './pending.js';

export async function applyComment(kaiten: AgentKaiten, pending: CommentPending): Promise<string> {
  try {
    await kaiten.addComment(pending.cardId, pending.text);
    return `Отправлено: комментарий к карточке #${pending.cardId} «${pending.cardTitle}».`;
  } catch (error) {
    if (error instanceof KaitenApiError) return `Не отправлено: Kaiten ответил ошибкой ${error.status}.`;
    throw error;
  }
}

/** Что не так с файлом для этой карточки — по её файлам на этот момент. Пусто — можно. */
export async function uploadProblems(kaiten: AgentKaiten, pending: UploadPending, name: string, bytes: Uint8Array): Promise<string[]> {
  const card = await kaiten.getCard(pending.cardId);
  return fileProblems(name, bytes, (card.files ?? []).map((f) => f.name), MAX_UPLOAD_BYTES);
}

export async function applyUpload(kaiten: AgentKaiten, pending: UploadPending, name: string, bytes: Uint8Array): Promise<string> {
  try {
    await kaiten.uploadCardFile(pending.cardUid, name, bytes);
    return `Файл «${name}» приложен к карточке #${pending.cardId} «${pending.cardTitle}».`;
  } catch (error) {
    if (error instanceof KaitenApiError) return `Не загружено: Kaiten ответил ошибкой ${error.status}.`;
    throw error;
  }
}
