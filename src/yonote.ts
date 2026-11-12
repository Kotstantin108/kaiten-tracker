/**
 * Разовая выгрузка базы знаний yonote — только на чтение: забрать всё, пока
 * доступ есть. Переводить пространство в read-only или выключать скрипт не умеет.
 *
 * ДВА РЕЖИМА.
 *   · По умолчанию — разведка: опрашивает все списки документов по отдельности
 *     (опубликованные, черновики, архив, корзина, шаблоны), считает, пишет
 *     `summary.json` и индекс метаданных. Тексты и вложения не качает. Это
 *     первый живой шаг: видно, какие методы у yonote вообще есть, и можно
 *     сверить числа с интерфейсом.
 *   · `--download` — выгрузка через API: текст каждого документа, таблицы баз
 *     данных (CSV + JSON со схемой), комментарии, индекс; вложения и ссылки
 *     переписываются на локальные файлы, если они есть в тексте.
 *
 * ОГРАНИЧЕНИЕ, ПРОВЕРЕННОЕ ЖИВЬЁМ 23.09.2026: поле `text` у yonote — почти
 * голый текст, без ссылок, картинок и таблиц (см. `yonote-client.ts`). Файлы
 * `docs/*.md` поэтому — текст, а не полноценный markdown, и вложений в них не
 * найти. Базы данных (задачи) это не задевает: они собираются из
 * структурированных `properties`/`values`. Разметку и вложения даёт только
 * штатный экспорт пространства — его делает владелец.
 *
 * ПДН. В корпоративной вики бывают персональные данные. В консоль идут только
 * счётчики — ни заголовков, ни текста, ни имён. Выгрузка пишется в `tmp/`
 * (в git не попадает); куда её класть потом, решает владелец — не в
 * репозиторий кода.
 *
 * ЧТО СЧИТАТЬ ЗАДАЧЕЙ, скрипт не решает: он считает чекбоксы и поле `tasks`
 * по каждому документу, а отбирает человек. Задачи потом уезжают в Kaiten
 * с `external_id = yonote:<documentId>`.
 *
 * ФЛАГИ
 *   --download          скачать тексты, вложения, комментарии
 *   --out <dir>         куда писать (по умолч. tmp/yonote)
 *   --limit <N>         не больше N документов в --download (проба)
 *   --no-attachments    в --download не качать вложения
 *   --no-comments       в --download не качать комментарии
 *
 * ENV: `YONOTE_DOMAIN` (домен команды, например `acme.yonote.ru`) и
 * `YONOTE_TOKEN`. Запуск: `npm run yonote` или `npm run yonote -- --download`.
 *
 * Коды выхода: 0 — ок; 2 — нет адреса или токена; 6 — ошибка выполнения.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  YONOTE_DOCUMENT_TYPES,
  YonoteApiError,
  YonoteClient,
  type YonoteCollection,
  type YonoteDocument,
} from './yonote-client.js';
import {
  countCheckboxes,
  databaseCsv,
  documentPath,
  extensionFor,
  externalHosts,
  findAttachmentRefs,
  rewriteLinks,
  type CheckboxCount,
} from './yonote-export.js';
import { endWith } from './exit.js';

/**
 * Списки документов. Каждый опрашивается отдельно: у Outline черновики,
 * архив и корзина — разные методы, и `documents.list` их не отдаёт. Все пять
 * у yonote живы (проверено 23.09.2026). Полный список типов передаётся явно:
 * без него `documents.list` молча прячет строки баз данных — см.
 * `YONOTE_DOCUMENT_TYPES`.
 */
const ALL_TYPES = { type: [...YONOTE_DOCUMENT_TYPES] };
const SOURCES: Array<{ key: string; method: string; body?: Record<string, unknown> }> = [
  { key: 'published', method: 'documents.list', body: ALL_TYPES },
  { key: 'drafts', method: 'documents.drafts', body: ALL_TYPES },
  { key: 'archived', method: 'documents.archived', body: ALL_TYPES },
  { key: 'deleted', method: 'documents.deleted', body: ALL_TYPES },
  { key: 'templates', method: 'documents.list', body: { template: true } },
];

type SourceResult = { method: string; ok: true; count: number } | { method: string; ok: false; status: number | null; error: string };

type DocStatus = 'published' | 'draft' | 'archived' | 'deleted' | 'template';

interface IndexEntry {
  id: string;
  urlId: string | null;
  url: string | null;
  title: string;
  /** Тип форка: document | database | row | embed | whiteboard. */
  type: string;
  /** Номер строки базы — похоже на номер задачи. */
  numId: number | null;
  status: DocStatus;
  sources: string[];
  collectionId: string | null;
  collection: string | null;
  parentDocumentId: string | null;
  path: string[];
  createdAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdBy: { id: string; name: string | null } | null;
  updatedBy: { id: string; name: string | null } | null;
  /** Поле `tasks` из API, если форк его отдаёт. */
  tasksField: { completed: number; total: number } | null;
  /** Чекбоксы, посчитанные по тексту (только в --download). */
  checkboxes: CheckboxCount | null;
  file: string | null;
  textSource: 'documents.info' | 'list' | null;
  textLength: number | null;
  attachments: string[];
  comments: number | null;
  errors: string[];
}

interface Args {
  download: boolean;
  out: string;
  limit: number | undefined;
  attachments: boolean;
  comments: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const known = new Set(['--download', '--out', '--limit', '--no-attachments', '--no-comments']);
  for (const a of argv) {
    if (a.startsWith('--') && !known.has(a.split('=')[0])) throw new Error(`Неизвестный флаг ${a}`);
  }
  const limitRaw = value('--limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit: нужно целое > 0');
  return {
    download: argv.includes('--download'),
    out: value('--out') ?? 'tmp/yonote',
    limit,
    attachments: !argv.includes('--no-attachments'),
    comments: !argv.includes('--no-comments'),
  };
}

function statusOf(doc: YonoteDocument): DocStatus {
  if (doc.deletedAt) return 'deleted';
  if (doc.template) return 'template';
  if (doc.archivedAt) return 'archived';
  if (!doc.publishedAt) return 'draft';
  return 'published';
}

function describeError(error: unknown): { status: number | null; error: string } {
  if (error instanceof YonoteApiError) return { status: error.status, error: error.message };
  return { status: null, error: error instanceof Error ? error.message : String(error) };
}

const person = (p: YonoteDocument['createdBy']): IndexEntry['createdBy'] => (p ? { id: p.id, name: p.name ?? null } : null);

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.YONOTE_DOMAIN ?? '';
  const token = process.env.YONOTE_TOKEN ?? '';
  if (!baseUrl || !token) {
    console.error('Нужны YONOTE_DOMAIN и YONOTE_TOKEN в окружении (`--env-file=.env`).');
    process.exit(2);
  }

  const client = new YonoteClient({ baseUrl, token });
  mkdirSync(args.out, { recursive: true });

  // Кто мы: от прав токена зависит, что видно (чужие черновики в Outline не видны никому).
  let authOk = false;
  try {
    await client.authInfo();
    authOk = true;
  } catch (error) {
    console.error(`auth.info не прошёл: ${describeError(error).error}`);
  }

  let collections: YonoteCollection[] = [];
  let collectionsResult: SourceResult;
  try {
    collections = await client.collections();
    collectionsResult = { method: 'collections.list', ok: true, count: collections.length };
  } catch (error) {
    collectionsResult = { method: 'collections.list', ok: false, ...describeError(error) };
  }
  const collectionNames = new Map(collections.map((c) => [c.id, c.name]));

  const sources: Record<string, SourceResult> = {};
  const docs = new Map<string, YonoteDocument>();
  const seenIn = new Map<string, Set<string>>();
  for (const source of SOURCES) {
    try {
      const list = await client.documents(source.method, source.body);
      sources[source.key] = { method: source.method, ok: true, count: list.length };
      for (const doc of list) {
        if (!docs.has(doc.id)) docs.set(doc.id, doc);
        const set = seenIn.get(doc.id) ?? new Set<string>();
        set.add(source.key);
        seenIn.set(doc.id, set);
      }
    } catch (error) {
      sources[source.key] = { method: source.method, ok: false, ...describeError(error) };
    }
  }

  const byId = new Map([...docs.values()].map((d) => [d.id, d]));
  const docIdByUrlId = new Map(
    [...docs.values()].filter((d) => d.urlId).map((d) => [d.urlId as string, d.id]),
  );

  const entries: IndexEntry[] = [...docs.values()].map((doc) => ({
    id: doc.id,
    urlId: doc.urlId ?? null,
    url: doc.url ? new URL(doc.url, client.baseUrl).toString() : null,
    title: doc.title,
    type: doc.type ?? 'document',
    numId: doc.numId ?? null,
    status: statusOf(doc),
    sources: [...(seenIn.get(doc.id) ?? [])].sort(),
    collectionId: doc.collectionId ?? null,
    collection: doc.collectionId ? (collectionNames.get(doc.collectionId) ?? null) : null,
    parentDocumentId: doc.parentDocumentId ?? null,
    path: documentPath(doc, byId, collectionNames),
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    publishedAt: doc.publishedAt ?? null,
    archivedAt: doc.archivedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    createdBy: person(doc.createdBy),
    updatedBy: person(doc.updatedBy),
    tasksField: doc.tasks ? { completed: doc.tasks.completed, total: doc.tasks.total } : null,
    checkboxes: null,
    file: null,
    textSource: null,
    textLength: null,
    attachments: [],
    comments: null,
    errors: [],
  }));
  entries.sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')) || a.id.localeCompare(b.id));

  const download = { documents: 0, textFailed: 0, attachmentsFound: 0, attachmentsDownloaded: 0, attachmentsFailed: 0, commentsOk: 0, commentsFailed: 0 };
  const hostDocs = new Map<string, number>();
  let unresolvedDocLinks = 0;
  let missingAttachments = 0;
  let commentsDisabled: string | null = args.comments ? null : 'выключено флагом';

  if (args.download) {
    const docsDir = join(args.out, 'docs');
    const attDir = join(args.out, 'attachments');
    const commentsDir = join(args.out, 'comments');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(attDir, { recursive: true });

    // Уже скачанные вложения не качаем повторно: прогон можно прервать и продолжить.
    const attachmentFiles = new Map<string, string>();
    for (const file of readdirSync(attDir)) attachmentFiles.set(file.replace(/\.[^.]+$/, ''), file);
    const failedAttachments = new Set<string>();

    const selected = args.limit === undefined ? entries : entries.slice(0, args.limit);
    for (const entry of selected) {
      let text: string | undefined;
      try {
        text = (await client.documentInfo(entry.id)).text;
        entry.textSource = 'documents.info';
      } catch (error) {
        entry.errors.push(`documents.info: ${describeError(error).error}`);
        text = byId.get(entry.id)?.text;
        if (text !== undefined) entry.textSource = 'list';
      }
      if (text === undefined) {
        download.textFailed++;
        continue;
      }

      const refs = findAttachmentRefs(text);
      entry.attachments = [...new Set(refs.map((r) => r.id))];
      if (args.attachments) {
        for (const id of entry.attachments) {
          if (attachmentFiles.has(id) || failedAttachments.has(id)) continue;
          download.attachmentsFound++;
          try {
            const file = await client.downloadAttachment(id);
            const name = `${id}${extensionFor(file.contentType)}`;
            writeFileSync(join(attDir, name), file.bytes);
            attachmentFiles.set(id, name);
            download.attachmentsDownloaded++;
          } catch (error) {
            failedAttachments.add(id);
            download.attachmentsFailed++;
            entry.errors.push(`вложение ${id}: ${describeError(error).error}`);
          }
        }
      }

      const rewritten = rewriteLinks(text, attachmentFiles, docIdByUrlId);
      unresolvedDocLinks += rewritten.unresolvedDocLinks.length;
      missingAttachments += rewritten.missingAttachments.length;
      for (const host of externalHosts(rewritten.markdown)) hostDocs.set(host, (hostDocs.get(host) ?? 0) + 1);

      entry.checkboxes = countCheckboxes(text);
      entry.textLength = text.trim().length;
      entry.file = `docs/${entry.id}.md`;
      writeFileSync(join(args.out, entry.file), `# ${entry.title}\n\n${rewritten.markdown}`, 'utf8');
      download.documents++;

      // Список отдаёт commentsCount — без комментариев не спрашиваем (сотни лишних запросов).
      const commentsCount = byId.get(entry.id)?.commentsCount;
      if (commentsDisabled === null && commentsCount !== 0) {
        try {
          const comments = await client.comments(entry.id);
          entry.comments = comments.length;
          download.commentsOk++;
          if (comments.length > 0) {
            mkdirSync(commentsDir, { recursive: true });
            writeFileSync(join(commentsDir, `${entry.id}.json`), JSON.stringify(comments, null, 2), 'utf8');
          }
        } catch (error) {
          const described = describeError(error);
          download.commentsFailed++;
          // Метода нет у форка — дальше не спрашиваем, чтобы не тратить сотни запросов.
          if (described.status === 404 || described.status === 400) commentsDisabled = described.error;
          else entry.errors.push(`comments.list: ${described.error}`);
        }
      }
    }
  }

  // Базы данных: схема + строки. В markdown их нет вовсе — текст базы пуст
  // или почти пуст, а задачи живут в свойствах строк. Без этого файла они бы
  // пропали при выключении yonote.
  const databases: Array<{ id: string; rows: number; properties: number }> = [];
  if (args.download) {
    const dbDir = join(args.out, 'databases');
    mkdirSync(dbDir, { recursive: true });
    for (const db of [...docs.values()].filter((d) => d.type === 'database')) {
      const properties = db.properties ?? {};
      const rows = [...docs.values()].filter((d) => d.type === 'row' && d.parentDocumentId === db.id);
      const tableRows = rows.map((r) => ({ id: r.id, title: r.title, numId: r.numId ?? null, values: r.values ?? null }));
      writeFileSync(join(dbDir, `${db.id}.csv`), databaseCsv(properties, tableRows), 'utf8');
      writeFileSync(
        join(dbDir, `${db.id}.json`),
        JSON.stringify(
          {
            id: db.id,
            title: db.title,
            path: entries.find((e) => e.id === db.id)?.path ?? [],
            properties,
            rows: rows.map((r) => ({ ...tableRows.find((t) => t.id === r.id), status: statusOf(r) })),
          },
          null,
          2,
        ),
        'utf8',
      );
      databases.push({ id: db.id, rows: rows.length, properties: Object.keys(properties).length });
    }
  }
  const rowsWithoutDatabase = entries.filter((e) => e.type === 'row' && !docs.get(e.parentDocumentId ?? '')).length;

  const withCheckboxes = entries.filter((e) => e.checkboxes && e.checkboxes.open + e.checkboxes.done > 0);
  const withTasksField = entries.filter((e) => e.tasksField && e.tasksField.total > 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: args.download ? 'download' : 'разведка (тексты не скачивались)',
    baseUrl: client.baseUrl,
    authInfo: authOk,
    requests: client.requestCount,
    collections: {
      ...collectionsResult,
      archived: collections.filter((c) => c.archivedAt).length,
    },
    sources,
    documents: {
      unique: entries.length,
      byStatus: countBy(entries, (e) => e.status),
      byType: countBy(entries, (e) => `${e.type}:${e.status}`),
      byCollection: countBy(entries, (e) => e.collection ?? '[без коллекции]'),
      /** Документ попал сразу в несколько списков — видно, пересекаются ли методы у форка. */
      bySourceSet: countBy(entries, (e) => e.sources.join('+')),
      parentOutsideExport: entries.filter((e) => e.path.some((p) => p.startsWith('[родитель '))).length,
    },
    databases: {
      count: entries.filter((e) => e.type === 'database').length,
      rows: entries.filter((e) => e.type === 'row').length,
      /** Строка, чья база не попала в выгрузку, — таблица для неё не собрана. */
      rowsWithoutDatabase,
      exported: args.download ? databases : null,
    },
    tasks: {
      docsWithTasksField: withTasksField.length,
      tasksFieldTotal: withTasksField.reduce((s, e) => s + (e.tasksField?.total ?? 0), 0),
      tasksFieldCompleted: withTasksField.reduce((s, e) => s + (e.tasksField?.completed ?? 0), 0),
      docsWithCheckboxes: withCheckboxes.length,
      checkboxesOpen: withCheckboxes.reduce((s, e) => s + (e.checkboxes?.open ?? 0), 0),
      checkboxesDone: withCheckboxes.reduce((s, e) => s + (e.checkboxes?.done ?? 0), 0),
    },
    download: args.download
      ? {
          ...download,
          limit: args.limit ?? null,
          unresolvedDocLinks,
          missingAttachments,
          commentsDisabled,
          externalHosts: Object.fromEntries([...hostDocs.entries()].sort(([a], [b]) => a.localeCompare(b))),
          docsWithErrors: entries.filter((e) => e.errors.length > 0).length,
          emptyTextByType: countBy(
            entries.filter((e) => e.file !== null && e.textLength === 0),
            (e) => e.type,
          ),
        }
      : null,
    notes: [
      'Черновики в Outline видит только их автор: documents.drafts отдаёт черновики владельца токена, чужие через API недоступны.',
      'Поле tasks — чекбоксы документа в терминах Outline, а не отдельная сущность задач.',
      'documents.list без явного type не отдаёт строки баз (row) — все списки запрашиваются с полным списком типов.',
      'Доски (whiteboard) не имеют markdown-текста: их содержимое через documents.info не выгружается.',
      'Поле text у yonote — почти голый текст: ссылок, картинок, таблиц в нём нет (проверено 23.09.2026). docs/*.md — текст, не полноценный markdown; вложений по нему не найти. Разметку и вложения даёт только штатный экспорт пространства.',
      'Токен без роли админа: закрытые коллекции, к которым у владельца токена нет доступа, в выгрузку не попадают.',
    ],
  };

  writeFileSync(join(args.out, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(join(args.out, 'index.json'), JSON.stringify(entries, null, 2), 'utf8');
  writeFileSync(join(args.out, 'index.md'), renderIndex(entries), 'utf8');

  // В консоль — только числа: заголовки и имена остаются в файлах выгрузки.
  console.log(`yonote: ${args.download ? 'выгрузка' : 'разведка'} → ${args.out} (запросов: ${client.requestCount})`);
  console.log(`  коллекции: ${collectionsResult.ok ? collectionsResult.count : `ошибка ${collectionsResult.status ?? ''}`}`);
  for (const [key, r] of Object.entries(sources)) {
    console.log(`  ${key.padEnd(10)} ${r.method.padEnd(20)} ${r.ok ? r.count : `нет (${r.status ?? r.error})`}`);
  }
  console.log(`  уникальных документов: ${entries.length} ${JSON.stringify(summary.documents.byStatus)}`);
  console.log(`  по типам: ${JSON.stringify(summary.documents.byType)}`);
  console.log(`  базы данных: ${summary.databases.count}, строк: ${summary.databases.rows}, строк без своей базы: ${rowsWithoutDatabase}`);
  console.log(`  с полем tasks: ${withTasksField.length}; с чекбоксами по тексту: ${withCheckboxes.length}`);
  if (args.download) {
    console.log(
      `  скачано ${download.documents}, без текста ${download.textFailed}; вложения ${download.attachmentsDownloaded}/${download.attachmentsFound}, ошибок ${download.attachmentsFailed}`,
    );
  }
  if (existsSync(join(args.out, 'summary.json'))) console.log(`  подробности: ${join(args.out, 'summary.json')}`);
}

/** Дерево для человека: путь, статус, ссылка на файл. Порядок детерминирован. */
function renderIndex(entries: IndexEntry[]): string {
  const lines = [
    '# Выгрузка yonote',
    '',
    `Документов: ${entries.length}. Файлы docs/ — поле text из API: у yonote это почти голый текст, без ссылок, картинок и таблиц.`,
    '', '| Путь | Тип | Статус | Чекбоксы | Файл |', '|---|---|---|---|---|'];
  for (const e of entries) {
    const path = e.path.join(' / ').replace(/\|/g, '\\|');
    const boxes = e.checkboxes ? `${e.checkboxes.done}/${e.checkboxes.open + e.checkboxes.done}` : e.tasksField ? `${e.tasksField.completed}/${e.tasksField.total}` : '';
    lines.push(`| ${path} | ${e.type}${e.numId === null ? '' : ` #${e.numId}`} | ${e.status} | ${boxes} | ${e.file ? `[${e.id}](${e.file})` : e.id} |`);
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  endWith(6);
});
