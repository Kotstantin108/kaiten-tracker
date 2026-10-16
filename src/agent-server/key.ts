/**
 * Ключ агента — токен Kaiten, зашифрованный секретом сервера (AES-GCM).
 *
 * Токен Kaiten у клиента не лежит никогда: человек вводит его на странице
 * сервера и получает ключ, который работает только с этим сервером. Отозвать
 * доступ — перевыпустить токен в Kaiten. Тот же ключ лежит в props OAuth,
 * поэтому за обоими путями входа один и тот же механизм.
 *
 * Только Web Crypto: код работает и в Cloudflare Workers, и в Node.
 */

const PREFIX = 'kag1.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Ключ шифрования выводится из секрета сервера; назначение — в `info`, чтобы секрет не служил двум целям. */
async function deriveKey(secret: string, purpose: string, usage: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('Секрет сервера короче 32 символов');
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  const params = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(`kaiten-agent:${purpose}`) };
  return usage === 'AES-GCM'
    ? crypto.subtle.deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    : crypto.subtle.deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

async function sealText(purpose: string, text: string, secret: string): Promise<string> {
  const key = await deriveKey(secret, purpose, 'AES-GCM');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text)));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

async function openText(purpose: string, sealed: string, secret: string): Promise<string | null> {
  const bytes = fromBase64Url(sealed);
  if (!bytes || bytes.length < 12 + 16) return null;
  const key = await deriveKey(secret, purpose, 'AES-GCM');
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
  } catch {
    return null;
  }
}

/** Зашифровать токен Kaiten в ключ агента. */
export async function sealToken(token: string, secret: string): Promise<string> {
  return PREFIX + (await sealText('token', token, secret));
}

/** Зашифровать данные, которые сервер хранит у себя (подтверждения, копии страниц). */
export async function sealData(value: unknown, secret: string): Promise<string> {
  return sealText('store', JSON.stringify(value), secret);
}

export async function openData(sealed: string, secret: string): Promise<unknown> {
  const text = await openText('store', sealed, secret);
  return text === null ? null : (JSON.parse(text) as unknown);
}

/** Похоже ли значение на ключ агента (без расшифровки). */
export function looksLikeAgentKey(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Расшифровать ключ агента; `null` — ключ чужой, испорчен или выпущен другим секретом. */
export async function openKey(agentKey: string, secret: string): Promise<string | null> {
  if (!looksLikeAgentKey(agentKey)) return null;
  const token = await openText('token', agentKey.slice(PREFIX.length), secret);
  return token ? token : null;
}

/** Подпись HMAC секретом сервера под своё назначение (коды предпросмотра, ссылки подтверждения). */
export async function sign(purpose: string, payload: string, secret: string): Promise<string> {
  const key = await deriveKey(secret, purpose, 'HMAC');
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

/** Проверка подписи без утечки по времени (сравнение делает Web Crypto). */
export async function verify(purpose: string, payload: string, signature: string, secret: string): Promise<boolean> {
  const bytes = fromBase64Url(signature);
  if (!bytes) return false;
  const key = await deriveKey(secret, purpose, 'HMAC');
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(payload));
}
