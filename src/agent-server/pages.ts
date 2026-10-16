/**
 * Страницы сервера для человека: получить ключ, войти по OAuth.
 *
 * Всё, что пришло от клиента OAuth (имя, адрес возврата), — экранируется:
 * при динамической регистрации эти строки выбирает кто угодно. Токен Kaiten
 * принимается только формой POST и не попадает ни в адрес, ни в журнал.
 */

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--accent:#2f5bd3;--warn:#a23b1e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ededea;--muted:#a3a39c;--card:#20201f;--line:#33332f;--accent:#7d9cf0;--warn:#f08a6c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}
p{margin:8px 0}.muted{color:var(--muted)}.warn{color:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
label{display:block;font-weight:600;margin:12px 0 6px}input[type=password],textarea{width:100%;font:14px ui-monospace,Consolas,monospace;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:88px;resize:vertical}pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font:13px ui-monospace,Consolas,monospace;margin:8px 0}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;margin:12px 8px 0 0}
button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** Заголовки страниц: без кэша (на странице может быть ключ) и без встраивания в чужие сайты. */
export function htmlHeaders(extra?: Headers): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  return headers;
}

const TOKEN_HINT = 'Токен создаётся в Kaiten, в настройках профиля (раздел про API). Сервер не хранит его в открытом виде.';

function tokenField(): string {
  return `<label for="token">Токен Kaiten</label>
<input id="token" name="token" type="password" autocomplete="off" required>
<p class="muted">${TOKEN_HINT}</p>`;
}

export function homePage(origin: string, error?: string): string {
  return page(
    'Агент для Kaiten',
    `<h1>Агент для Kaiten</h1>
<p>Через этот сервер ваш ИИ-агент (Claude, Codex, Cursor, OpenClaw) ведёт задачи и документы в Kaiten от вашего имени — по правилам досок, без права удалять.</p>
<h2>Claude, Cursor и другие с кнопкой «Подключить»</h2>
<p>Добавьте коннектор с адресом:</p><pre>${escapeHtml(origin)}/mcp</pre>
<p class="muted">При подключении откроется эта же страница сервера — вставьте туда токен Kaiten.</p>
<h2>Codex, OpenClaw и другие без браузера</h2>
<p>Получите ключ и пропишите его в настройках агента.</p>
<form method="post" action="/key" class="card">
${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
${tokenField()}
<button type="submit">Получить ключ</button>
</form>`,
  );
}

export function keyPage(origin: string, key: string, userName: string): string {
  const url = `${origin}/mcp`;
  const codex = `[mcp_servers.kaiten]\nurl = "${url}"\nbearer_token_env_var = "KAITEN_AGENT_KEY"`;
  const openclaw = `"kaiten": {\n  "url": "${url}",\n  "transport": "streamable-http",\n  "headers": { "Authorization": "Bearer \${KAITEN_AGENT_KEY}" }\n}`;
  return page(
    'Ключ агента',
    `<h1>Ключ для ${escapeHtml(userName)}</h1>
<p class="warn">Ключ показывается один раз. Он даёт агенту ваши права в Kaiten — не пересылайте его.</p>
<textarea readonly>${escapeHtml(key)}</textarea>
<p class="muted">Отозвать: перевыпустите токен в Kaiten — старый ключ перестанет работать.</p>
<h2>Codex</h2><p>Переменная окружения <code>KAITEN_AGENT_KEY</code> = ключ, в <code>~/.codex/config.toml</code>:</p><pre>${escapeHtml(codex)}</pre>
<h2>OpenClaw</h2><p>В <code>~/.openclaw/openclaw.json</code>, раздел <code>mcp.servers</code>:</p><pre>${escapeHtml(openclaw)}</pre>
<h2>Другие</h2><p>Адрес <code>${escapeHtml(url)}</code>, заголовок <code>Authorization: Bearer &lt;ключ&gt;</code>.</p>`,
  );
}

export interface ConsentView {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
}

/** Описание клиента из скрытых полей формы — только чтобы повторно показать ту же страницу после ошибки. */
export function consentViewFromForm(form: FormData): ConsentView {
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const domain = field('client_domain');
  return {
    clientName: field('client_name') || 'приложение',
    ...(domain ? { clientDomain: domain } : {}),
    redirectHost: field('redirect_host') || 'неизвестно',
    redirectIsLoopback: field('redirect_loopback') === '1',
  };
}

export function authorizePage(view: ConsentView, handle: string, error?: string): string {
  const who = view.clientDomain
    ? `Приложение <strong>${escapeHtml(view.clientName)}</strong> с сайта <strong>${escapeHtml(view.clientDomain)}</strong>`
    : `Приложение, назвавшееся <strong>${escapeHtml(view.clientName)}</strong> (имя не проверено),`;
  return page(
    'Подключение агента к Kaiten',
    `<h1>Подключить агента к Kaiten?</h1>
<p>${who} просит доступ к Kaiten от вашего имени. Доступ уйдёт на <strong>${escapeHtml(view.redirectHost)}</strong>.</p>
${view.redirectIsLoopback ? '<p class="warn">Доступ уходит программе на этом компьютере. Продолжайте, только если вы сами только что начали подключение.</p>' : ''}
<form method="post" class="card">
${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="client_name" value="${escapeHtml(view.clientName)}">
<input type="hidden" name="client_domain" value="${escapeHtml(view.clientDomain ?? '')}">
<input type="hidden" name="redirect_host" value="${escapeHtml(view.redirectHost)}">
<input type="hidden" name="redirect_loopback" value="${view.redirectIsLoopback ? '1' : ''}">
${tokenField()}
<button type="submit" name="decision" value="approve">Подключить</button>
<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Отказать</button>
</form>`,
  );
}

export function loginPage(next: string, error?: string): string {
  return page(
    'Вход',
    `<h1>Войдите, чтобы подтвердить действие агента</h1>
<p>Подтверждать может только человек. Агент войти сюда не может: у него нет вашего токена Kaiten.</p>
<form method="post" action="/login" class="card">
${error ? `<p class="warn">${escapeHtml(error)}</p>` : ''}
<input type="hidden" name="next" value="${escapeHtml(next)}">
${tokenField()}
<button type="submit">Войти</button>
</form>`,
  );
}

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Построчная разница (LCS); для очень длинных страниц — просто «было» и «стало». */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i++] });
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) out.push({ kind: 'add', text: b[j++] });
    else out.push({ kind: 'del', text: a[i++] });
  }
  return out;
}

function renderDiff(lines: DiffLine[]): string {
  const keep = lines.map((l, i) => l.kind !== 'same' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.kind !== 'same'));
  const out: string[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) out.push(`<div class="muted">… без изменений: ${skipped} строк …</div>`);
    skipped = 0;
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
    out.push(`<div class="d-${line.kind}">${sign} ${escapeHtml(line.text) || '&nbsp;'}</div>`);
  });
  if (skipped) out.push(`<div class="muted">… без изменений: ${skipped} строк …</div>`);
  return out.join('');
}

export interface ConfirmView {
  docTitle: string;
  summary: string;
  by: string;
  before: string;
  after: string;
}

export function confirmPage(view: ConfirmView, csrf: string): string {
  return page(
    'Подтверждение',
    `<style>.diff{font:13px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:60vh;overflow:auto}
.d-add{background:rgba(46,160,67,.18)}.d-del{background:rgba(248,81,73,.18);text-decoration:line-through}</style>
<h1>Агент просит подтвердить</h1>
<p><strong>${escapeHtml(view.summary)}</strong></p>
<p class="muted">Документ «${escapeHtml(view.docTitle)}». Запрошено от имени: ${escapeHtml(view.by)}. Перед записью сервер сохранит копию — её можно будет откатить.</p>
<div class="diff">${renderDiff(lineDiff(view.before, view.after))}</div>
<form method="post" class="card">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="decision" value="apply">Применить</button>
<button type="submit" name="decision" value="reject" class="secondary">Отклонить</button>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
