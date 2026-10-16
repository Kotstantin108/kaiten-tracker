/**
 * Файл, который агент или человек кладёт в карточку: какие можно и какого
 * размера. Одна проверка для обоих путей — содержимого в аргументе
 * инструмента и страницы загрузки.
 *
 * Тип проверяется и по расширению, и по началу содержимого: расширение
 * выбирает тот, кто прислал файл, а открывать его будут люди в Kaiten.
 * Архивы и исполняемые файлы — нельзя; ZIP-сигнатура допустима только у
 * `.docx` и `.xlsx` (это и есть ZIP).
 *
 * Имя не должно совпадать с файлом, который уже есть в карточке, и с
 * журналом задачи: одинаковое имя Kaiten заводит вторым файлом, а файлами
 * задачи из git владеет синхронизация — она заменила бы чужой.
 */

import { JOURNAL_FILE } from '../core/schema.js';
import { MAX_UPLOAD_BYTES } from './gate.js';

/** Содержимое прямо в аргументе инструмента — меньше: оно идёт через агента. */
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;
export { MAX_UPLOAD_BYTES };

type Kind = 'pdf' | 'png' | 'jpg' | 'webp' | 'zip' | 'ole' | 'text';

const BY_EXTENSION: Record<string, Kind> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
  docx: 'zip',
  xlsx: 'zip',
  xls: 'ole',
  csv: 'text',
  txt: 'text',
  md: 'text',
};

export const ALLOWED_EXTENSIONS = Object.keys(BY_EXTENSION);

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((b, i) => bytes[at + i] === b);

function looksLike(kind: Kind, bytes: Uint8Array): boolean {
  switch (kind) {
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case 'zip':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case 'ole':
      return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'text':
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
        return true;
      } catch {
        return false;
      }
  }
}

function formatLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

/** Что не так с файлом; пусто — можно загружать. */
export function fileProblems(name: string, bytes: Uint8Array, existing: readonly string[], maxBytes: number): string[] {
  const problems: string[] = [];
  const trimmed = name.trim();
  if (!trimmed) return ['у файла нет имени'];
  if (/[/\\]/.test(trimmed)) problems.push('имя файла — без папок: без «/» и «\\»');
  if (trimmed.length > 200) problems.push('имя файла длиннее 200 символов');
  const extension = /\.([A-Za-z0-9]+)$/.exec(trimmed)?.[1]?.toLowerCase();
  const kind = extension ? BY_EXTENSION[extension] : undefined;
  if (!kind) problems.push(`такой тип файла не загружаем; можно: ${ALLOWED_EXTENSIONS.join(', ')}`);
  if (bytes.length === 0) problems.push('файл пустой');
  else if (bytes.length > maxBytes) problems.push(`файл больше ${formatLimit(maxBytes)}`);
  else if (kind && !looksLike(kind, bytes)) problems.push(`содержимое не похоже на .${extension} — проверьте, тот ли это файл`);
  const lower = trimmed.toLowerCase();
  if (lower === JOURNAL_FILE.toLowerCase()) problems.push(`имя «${JOURNAL_FILE}» занято журналом задачи — назовите файл иначе`);
  else if (existing.some((n) => n.toLowerCase() === lower)) problems.push(`в карточке уже есть файл «${trimmed}» — назовите новый иначе`);
  return problems;
}

/** base64 → байты; `null` — это не base64. */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '').replace(/^data:[^,]*;base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
