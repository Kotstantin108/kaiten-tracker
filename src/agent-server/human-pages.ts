/**
 * Страницы, где человек подтверждает действие агента: правку документа,
 * комментарий заказчику или гостю, загрузку файла в карточку.
 *
 * Общий порядок: вход человека (куки сессии, поставленный при вводе токена),
 * запись одноразовой ссылки, тот ли это человек, токен формы (CSRF). Ссылка
 * гасится до выполнения — повторная отправка формы ничего не сделает; у
 * загрузки — после проверки файла, чтобы человек мог выбрать другой.
 *
 * На стандартных Request/Response: облако знает только `worker.ts`.
 */

import { applyComment, applyUpload, uploadProblems } from './card-pending.js';
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES } from './card-files.js';
import { applyPending, loadPending } from './docs.js';
import { openKey } from './key.js';
import { kaitenFor } from './mcp.js';
import { commentConfirmPage, confirmPage, htmlHeaders, loginPage, messagePage, uploadPage } from './pages.js';
import { CommentPendingSchema, dropPending, pendingKind, readPending, UploadPendingSchema } from './pending.js';
import { checkCsrf, csrfToken, readSession, sessionValue } from './session.js';
import type { Store } from './store.js';

export interface HumanDeps {
  store: Store;
  secret: string;
  /** Домен компании в Kaiten. */
  domain: string;
  /** Подменяется в тестах. */
  fetchImpl?: typeof fetch;
}

const html = (body: string, status = 200): Response => new Response(body, { status, headers: htmlHeaders() });

const gone = (): Response => html(messagePage('Ссылка не действует', 'Она устарела (30 минут) или уже использована. Попросите агента повторить действие.'), 410);
const notYours = (): Response => html(messagePage('Не ваше подтверждение', 'Это действие запросил другой человек — подтверждает только он.'), 403);
const staleForm = (): Response => html(messagePage('Ошибка', 'Форма устарела — откройте ссылку заново.'), 400);

const domainOf = (domain: string): string => domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function kaitenOf(deps: HumanDeps, agentKey: string): Promise<ReturnType<typeof kaitenFor> | null> {
  const token = await openKey(agentKey, deps.secret);
  return token ? kaitenFor({ domain: deps.domain, token, secret: deps.secret, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }) : null;
}

const keyGone = (title: string): Response => html(messagePage(title, 'Ключ агента больше не действует — подключите агента заново.'), 400);

/** Вошедший человек: id и значение куки; `null` — показать вход. */
async function sessionOf(request: Request, secret: string): Promise<{ userId: number; cookie: string } | null> {
  const cookie = sessionValue(request.headers.get('Cookie'));
  const session = await readSession(cookie, secret);
  return session && cookie ? { userId: session.userId, cookie } : null;
}

/** `/confirm/{id}`: правка документа или комментарий. */
export async function confirmRoute(request: Request, deps: HumanDeps, id: string): Promise<Response> {
  const session = await sessionOf(request, deps.secret);
  if (!session) return html(loginPage(`/confirm/${id}`));
  const raw = await readPending(deps.store, deps.secret, id);
  const kind = pendingKind(raw);
  if (kind === 'upload') return html(messagePage('Это ссылка загрузки', 'Откройте ссылку, которую дал агент, целиком.'), 404);

  if (kind === 'comment') {
    const parsed = CommentPendingSchema.safeParse(raw);
    if (!parsed.success) return gone();
    const pending = parsed.data;
    if (pending.userId !== session.userId) return notYours();
    if (request.method === 'GET') return html(commentConfirmPage(pending, await csrfToken(session.cookie, id, deps.secret)));
    const form = await request.formData();
    if (!(await checkCsrf(session.cookie, id, String(form.get('csrf') ?? ''), deps.secret))) return staleForm();
    await dropPending(deps.store, id);
    if (form.get('decision') !== 'apply') return html(messagePage('Отклонено', 'Комментарий не отправлен. Агент узнает об этом, когда вы ему скажете.'));
    const kaiten = await kaitenOf(deps, pending.agentKey);
    if (!kaiten) return keyGone('Не отправлено');
    const result = await applyComment(kaiten, pending);
    return html(messagePage(result.startsWith('Отправлено') ? 'Готово' : 'Не отправлено', result));
  }

  const pending = await loadPending(deps.store, deps.secret, id);
  if (!pending) return gone();
  if (pending.userId !== session.userId) return notYours();
  if (request.method === 'GET') {
    return html(confirmPage({ docTitle: pending.docTitle, summary: pending.summary, by: pending.by, before: pending.before, after: pending.after }, await csrfToken(session.cookie, id, deps.secret)));
  }
  const form = await request.formData();
  if (!(await checkCsrf(session.cookie, id, String(form.get('csrf') ?? ''), deps.secret))) return staleForm();
  // Одноразово: сначала гасим ссылку, потом выполняем — повторная отправка формы ничего не сделает.
  await dropPending(deps.store, id);
  if (form.get('decision') !== 'apply') return html(messagePage('Отклонено', 'Ничего не записано. Агент узнает об этом, когда вы ему скажете.'));
  const kaiten = await kaitenOf(deps, pending.agentKey);
  if (!kaiten) return keyGone('Не применено');
  const result = await applyPending({ kaiten, store: deps.store, secret: deps.secret, domain: domainOf(deps.domain) }, pending);
  return html(messagePage(result.startsWith('Применено') ? 'Готово' : 'Не применено', result));
}

/** Запас на поля формы сверх самого файла. */
const FORM_OVERHEAD = 64 * 1024;

/** `/upload/{id}`: человек выбирает файл, сервер кладёт его в карточку. */
export async function uploadRoute(request: Request, deps: HumanDeps, id: string): Promise<Response> {
  const session = await sessionOf(request, deps.secret);
  if (!session) return html(loginPage(`/upload/${id}`));
  const parsed = UploadPendingSchema.safeParse(await readPending(deps.store, deps.secret, id));
  if (!parsed.success) return gone();
  const pending = parsed.data;
  if (pending.userId !== session.userId) return notYours();
  const csrf = await csrfToken(session.cookie, id, deps.secret);
  const view = { cardTitle: pending.cardTitle, cardId: pending.cardId, by: pending.by, extensions: ALLOWED_EXTENSIONS, maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 };
  if (request.method === 'GET') return html(uploadPage(view, csrf));

  // Заголовка может не быть — тогда размер проверит fileProblems по самому файлу.
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES + FORM_OVERHEAD) return html(uploadPage(view, csrf, 'Файл больше 10 МБ — выберите поменьше.'), 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return html(uploadPage(view, csrf, 'Форма не прочиталась — выберите файл заново.'), 400);
  }
  if (!(await checkCsrf(session.cookie, id, String(form.get('csrf') ?? ''), deps.secret))) return staleForm();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return html(uploadPage(view, csrf, 'Выберите файл.'), 400);
  const name = file.name.split(/[/\\]/).pop() ?? '';
  const bytes = new Uint8Array(await file.arrayBuffer());

  const kaiten = await kaitenOf(deps, pending.agentKey);
  if (!kaiten) return keyGone('Не загружено');
  const problems = await uploadProblems(kaiten, pending, name, bytes);
  if (problems.length > 0) return html(uploadPage(view, csrf, problems.join('; ')), 400);
  await dropPending(deps.store, id);
  const result = await applyUpload(kaiten, pending, name, bytes);
  return html(messagePage(result.startsWith('Файл') ? 'Готово' : 'Не загружено', result));
}
