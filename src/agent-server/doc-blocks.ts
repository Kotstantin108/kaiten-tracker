/**
 * Блоки в документах: встроенная страница, видео YouTube, картинка по ссылке
 * и картинка файлом. Узлы сняты живьём 10.11.2026 (docs/kaiten-api.md,
 * «Документы»):
 *   · встроенная страница и видео — `embed {src, size}`; видео YouTube — тот же
 *     `embed` со ссылкой youtube.com, отдельного узла нет;
 *   · картинка по ссылке — `image {src, size}`;
 *   · картинка файлом — `image {src, size, fileId}`, `src` — `url` из ответа
 *     загрузки `POST /documents/{uid}/files`.
 * Видео файлом Kaiten не показывает (`video` — 500), поэтому его нет.
 *
 * В markdown агента блок — отдельная строка:
 *   `@[embed](https://…)`, `@[embed medium](https://…)`, `@[video](https://youtube…)`,
 *   `![](https://…/x.png)`, `![](file:график.png)` — файл из аргумента `files`.
 *
 * Новое выключено по умолчанию: блоки разрешает ключ `blocks` в правилах
 * папки. Блок, который уже был на странице и вернулся без изменений, правилам
 * не подчиняется и уходит в Kaiten тем же узлом — со всеми атрибутами.
 *
 * В ссылке встроенного блока бывает секрет (часть после #): в подтверждения,
 * историю и отказы попадает только домен.
 */

import { z } from 'zod';

import { decodeBase64, type Kind, looksLike, MAX_INLINE_BYTES } from './card-files.js';
import type { PMNode } from './prosemirror.js';

export const BLOCK_SIZES = ['medium', 'large'] as const;
export type BlockSize = (typeof BLOCK_SIZES)[number];

const DOMAIN = /^(?=[^.]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export const BlocksRulesSchema = z
  .object({
    /** Встроенные страницы — только с доменов из `domains`. */
    embed: z.boolean().default(false),
    /** Видео YouTube — без списка доменов. */
    video: z.boolean().default(false),
    /** Картинки: файлом — всегда, по ссылке — только с доменов из `domains`. */
    images: z.boolean().default(false),
    domains: z.array(z.string().trim().toLowerCase().regex(DOMAIN, 'домен — вида example.com, без схемы, пути и порта')).default([]),
    /** Уровень правки, которая добавляет новый блок. */
    level: z.enum(['free', 'confirm']).default('confirm'),
  })
  .strict();
export type BlocksRules = z.infer<typeof BlocksRulesSchema>;

export type BlockKind = 'embed' | 'image';

const YOUTUBE = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

const hostOf = (src: string): string | null => {
  try {
    return new URL(src).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isYouTube = (host: string | null): boolean => host !== null && YOUTUBE.includes(host);

/** Узел — блок, который сервер умеет показать и вернуть; `null` — другой узел или блок без ссылки. */
export function blockKind(node: PMNode): BlockKind | null {
  if (node.type !== 'embed' && node.type !== 'image') return null;
  return typeof node.attrs?.src === 'string' && node.attrs.src !== '' ? node.type : null;
}

/** Какие блоки папка позволяет показывать и заменять. */
export function allowedKinds(rules: BlocksRules | undefined): ReadonlySet<BlockKind> {
  const kinds = new Set<BlockKind>();
  if (rules?.embed || rules?.video) kinds.add('embed');
  if (rules?.images) kinds.add('image');
  return kinds;
}

/** Ссылка без секрета: только схема и домен. */
export function redactUrl(src: string): string {
  const host = hostOf(src);
  return host ? `https://${host}/…` : '…';
}

const defaultSize = (src: string): BlockSize => (isYouTube(hostOf(src)) ? 'medium' : 'large');

/** Блок → строка markdown; `null` — узел не блок. */
export function blockMarkdown(node: PMNode, redact: boolean): string | null {
  const kind = blockKind(node);
  if (!kind) return null;
  const src = String(node.attrs?.src);
  if (kind === 'image') {
    const fileId = node.attrs?.fileId;
    if (typeof fileId === 'string' && fileId) return `![](file:${fileId})`;
    return `![](${redact ? redactUrl(src) : src})`;
  }
  const label = isYouTube(hostOf(src)) ? 'video' : 'embed';
  const size = node.attrs?.size;
  const sizeWord = typeof size === 'string' && size !== defaultSize(src) ? ` ${size}` : '';
  return `@[${label}${sizeWord}](${redact ? redactUrl(src) : src})`;
}

const IMAGE_LINE = /^\s*!\[[^\]]*\]\(\s*(\S+?)\s*\)\s*$/;
const EMBED_LINE = /^\s*@\[(?:embed|video)(?:\s+(medium|large))?\]\(\s*(\S+?)\s*\)\s*$/i;

/** Строка markdown → узел блока; `null` — строка не блок. Права и ссылку проверяет `resolveBlocks`. */
export function blockFromLine(line: string): PMNode | null {
  const image = IMAGE_LINE.exec(line);
  if (image) return { type: 'image', attrs: { src: image[1], size: 'medium' } };
  const embed = EMBED_LINE.exec(line);
  if (embed) return { type: 'embed', attrs: { src: embed[2], size: (embed[1]?.toLowerCase() as BlockSize | undefined) ?? defaultSize(embed[2]) } };
  return null;
}

/** Все блоки страницы, на любой глубине. */
export function collectBlocks(nodes: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    if (blockKind(node)) out.push(node);
    if (node.content) out.push(...collectBlocks(node.content));
  }
  return out;
}

// ── файлы ───────────────────────────────────────────────────────────────────

export interface NewFile {
  name: string;
  bytes: Uint8Array;
}

const IMAGE_EXTENSIONS: Record<string, Kind> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif' };
export const IMAGE_FILE_TYPES = Object.keys(IMAGE_EXTENSIONS);

/** Что не так с картинкой; пусто — можно загружать. Тип — и по расширению, и по содержимому. */
export function imageFileProblems(name: string, bytes: Uint8Array): string[] {
  const problems: string[] = [];
  const trimmed = name.trim();
  if (!trimmed) return ['у файла нет имени'];
  if (/[/\\]/.test(trimmed)) problems.push(`«${trimmed}»: имя файла — без папок, без «/» и «\\»`);
  if (trimmed.length > 200) problems.push(`«${trimmed.slice(0, 40)}…»: имя файла длиннее 200 символов`);
  const extension = /\.([A-Za-z0-9]+)$/.exec(trimmed)?.[1]?.toLowerCase();
  const kind = extension ? IMAGE_EXTENSIONS[extension] : undefined;
  if (!kind) problems.push(`«${trimmed}»: в документ загружаются только картинки — ${IMAGE_FILE_TYPES.join(', ')}`);
  if (bytes.length === 0) problems.push(`«${trimmed}»: файл пустой`);
  else if (bytes.length > MAX_INLINE_BYTES) problems.push(`«${trimmed}»: файл больше ${MAX_INLINE_BYTES / 1024 / 1024} МБ`);
  else if (kind && !looksLike(kind, bytes)) problems.push(`«${trimmed}»: содержимое не похоже на .${extension} — проверьте, тот ли это файл`);
  return problems;
}

/** Файлы из аргумента инструмента: base64 → байты. */
export function decodeFiles(files: ReadonlyArray<{ name: string; content_base64: string }> | undefined, problems: string[]): NewFile[] {
  const out: NewFile[] = [];
  for (const file of files ?? []) {
    const name = file.name.trim();
    const bytes = decodeBase64(file.content_base64);
    if (!bytes) problems.push(`«${name}»: content_base64 — не base64`);
    else if (out.some((f) => f.name.toLowerCase() === name.toLowerCase())) problems.push(`«${name}»: два файла с одним именем`);
    else out.push({ name, bytes });
  }
  return out;
}

// ── проверка и сборка ───────────────────────────────────────────────────────

export interface Upload {
  file: NewFile;
  /** Узел, в который после загрузки ляжут `src` и `fileId`. */
  node: PMNode;
}

export interface ResolvedBlocks {
  problems: string[];
  uploads: Upload[];
  /** Сколько блоков новых (не было на странице). */
  added: number;
}

function domainAllowed(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const NO_RULES = 'в этой папке блоки не разрешены — их включает ключ blocks в правилах папки';

function urlProblem(src: string, kind: BlockKind, rules: BlocksRules | undefined): string | null {
  const what = kind === 'image' ? 'картинка по ссылке' : 'встроенный блок';
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return `${what}: ссылка не разбирается — нужна полная ссылка https://…`;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') return `${what} с ${host || '?'}: только ссылки https`;
  if (url.username || url.password) return `${what} с ${host}: ссылка с логином или паролем не принимается`;
  if (url.port) return `${what} с ${host}: ссылка с портом не принимается`;
  if (!rules) return `${what} с ${host}: ${NO_RULES}`;
  const domains = rules.domains.length ? rules.domains.join(', ') : 'список пуст';
  if (kind === 'image') {
    if (!rules.images) return `${what} с ${host}: картинки в этой папке не разрешены`;
    return domainAllowed(host, rules.domains) ? null : `${what} с ${host}: домена нет в списке папки (${domains})`;
  }
  if (isYouTube(host) && rules.video) return null;
  const allowed = rules.embed && domainAllowed(host, rules.domains);
  if (allowed) return null;
  if (isYouTube(host)) return `видео с ${host}: видео в этой папке не разрешены`;
  if (!rules.embed) return `${what} с ${host}: встроенные блоки в этой папке не разрешены`;
  return `${what} с ${host}: домена нет в списке папки (${domains})`;
}

const clone = (node: PMNode): PMNode => JSON.parse(JSON.stringify(node)) as PMNode;

/**
 * Блоки в новых узлах раздела: прежние — вернуть теми же узлами, новые —
 * проверить по правилам папки, файлы — подготовить к загрузке. Узлы меняются
 * на месте. Ничего не пишет: загрузка — `uploadBlocks`, после всех проверок.
 */
export function resolveBlocks(sections: PMNode[][], ctx: { rules: BlocksRules | undefined; existing: readonly PMNode[]; files: readonly NewFile[] }): ResolvedBlocks {
  const problems: string[] = [];
  const uploads: Upload[] = [];
  const used = new Set<string>();
  let added = 0;
  for (const nodes of sections) for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const kind = blockKind(node);
    if (!kind) continue;
    const src = String(node.attrs?.src);
    if (kind === 'image' && src.startsWith('file:')) {
      const ref = src.slice(5).trim();
      const same = ctx.existing.find((n) => n.type === 'image' && n.attrs?.fileId === ref);
      if (same) {
        nodes[i] = clone(same);
        continue;
      }
      const file = ctx.files.find((f) => f.name.toLowerCase() === ref.toLowerCase());
      if (!file) {
        problems.push(`картинка «${ref}»: такого файла нет ни на странице, ни в files — передайте его в files (name и content_base64)`);
        continue;
      }
      used.add(file.name.toLowerCase());
      if (!ctx.rules?.images) problems.push(`картинка «${ref}»: ${ctx.rules ? 'картинки в этой папке не разрешены' : NO_RULES}`);
      problems.push(...imageFileProblems(file.name, file.bytes));
      uploads.push({ file, node });
      added++;
      continue;
    }
    const same = ctx.existing.find((n) => n.type === node.type && n.attrs?.src === src);
    if (same) {
      const kept = clone(same);
      // Размер встроенного блока агент может поменять; у картинки размер в markdown не передаётся.
      if (kind === 'embed' && kept.attrs) kept.attrs.size = node.attrs?.size;
      nodes[i] = kept;
      continue;
    }
    const problem = urlProblem(src, kind, ctx.rules);
    if (problem) problems.push(problem);
    added++;
  }
  for (const file of ctx.files) {
    if (!used.has(file.name.toLowerCase())) problems.push(`файл «${file.name}» передан, но на него нет строки ![](file:${file.name})`);
  }
  return { problems, uploads, added };
}

/** Загрузка файлов картинок в документ — после всех проверок. */
export async function uploadBlocks(
  kaiten: { uploadDocumentFile(docUid: string, name: string, content: Uint8Array): Promise<{ id: string; url: string }> },
  docUid: string,
  uploads: readonly Upload[],
): Promise<void> {
  for (const upload of uploads) {
    const file = await kaiten.uploadDocumentFile(docUid, upload.file.name, upload.file.bytes);
    upload.node.attrs = { src: file.url, size: 'medium', fileId: file.id };
  }
}

/** Правила блоков — одной строкой для list_docs и read_doc. */
export function blocksSummary(rules: BlocksRules | undefined): string {
  if (!rules || (!rules.embed && !rules.video && !rules.images)) return 'блоки (встроенные, видео, картинки): нет';
  const kinds: string[] = [];
  if (rules.embed) kinds.push('встроенные страницы');
  if (rules.video) kinds.push('видео YouTube');
  if (rules.images) kinds.push('картинки (файлом и по ссылке)');
  const domains = rules.embed || rules.images ? `; домены: ${rules.domains.length ? rules.domains.join(', ') : 'нет'}` : '';
  return `блоки: ${kinds.join(', ')}${domains}; новый блок — ${rules.level === 'free' ? 'свободно' : 'с подтверждением'}`;
}
