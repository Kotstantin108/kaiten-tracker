/**
 * Журнал выкаток в прод — чистая часть (`docs/releases.md`).
 *
 * Журнал — одна страница Kaiten с одной плоской таблицей: строка на изменение,
 * поля выкатки повторяются в каждой строке, новые сверху. Страницу читает
 * дашборд, поэтому формат жёсткий, а слова в колонках «Зона» и «Тип» — только
 * из словарей проекта (`releases` в `kaiten.json`).
 *
 * Страница — единственное хранилище для читателя, но не единственная копия:
 * та же запись лежит в аннотации тега `released/<версия>` репозитория кода.
 * Документ Kaiten пишется только целиком и без блокировки, открытый редактор
 * может задвоить его содержимое (docs/kaiten-api.md, «Документы») — из тегов
 * строки поверхности восстанавливаются.
 *
 * Здесь нет ни git, ни сети: разбор ввода, строки ⇄ узлы страницы, запись ⇄
 * текст тега, версии и решение «что не записано». Команда — `kaiten-release.ts`.
 */

import { z } from 'zod';

import type { PMNode } from '../agent-server/prosemirror.js';
import { logStamp } from './task-ops.js';

// ── слова формата ────────────────────────────────────────────────────────

export const RELEASE_EVENTS = ['релиз', 'откат'] as const;
export type ReleaseEvent = (typeof RELEASE_EVENTS)[number];

export const COLUMNS = ['Время (МСК)', 'Поверхность', 'Версия', 'Название', 'Событие', 'Зона', 'Раздел', 'Тип', 'Задача', 'Что изменилось'] as const;
/** Шапка первой версии журнала — без названия выкатки и раздела: такие страницы читаются и переписываются в новом виде. */
const COLUMNS_V1 = ['Время (МСК)', 'Поверхность', 'Версия', 'Событие', 'Зона', 'Тип', 'Задача', 'Что изменилось'] as const;

/** Первая строка страницы. По её началу страница узнаётся как журнал. */
export const NOTICE =
  'Журнал выкаток в прод. Страницу ведёт команда kaiten release: не правьте её руками и не держите открытой в редакторе во время выкатки — правка остановит запись.';
const NOTICE_START = 'Журнал выкаток в прод';

/** Пустая ячейка: изменение без задачи, зона и тип у отката. */
export const NONE = '—';
/** Пометка «время приблизительное» — перед временем: запись сделана позже выкатки. */
export const APPROX = '≈';

/** Теги с записями журнала в репозитории кода. */
export const RECORD_TAG_PREFIX = 'released/';

/** Сколько после коммита выкатка считается «только что вышла»: время записи — момент запуска команды. */
export const FRESH_MS = 2 * 60 * 60_000;

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
/** Версия — часть имени тега: без пробелов, косых черт и всего, что git в именах не принимает. */
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

export function versionProblem(version: string): string | null {
  if (!VERSION_RE.test(version) || version.includes('..') || version.endsWith('.') || version.endsWith('.lock')) {
    return `версия «${version}» не годится: латиница, цифры, точка, дефис и подчёркивание, начинается с буквы или цифры`;
  }
  return null;
}

// ── запись ───────────────────────────────────────────────────────────────

export interface ReleaseChange {
  /** Ключ задачи, как его показывает `kaiten`; `null` — изменение без задачи. */
  task: string | null;
  zone: string;
  type: string;
  /** Раздел списка изменений, в котором стоит правка: «Время рождения». `null` — правка вне разделов. */
  section: string | null;
  text: string;
}

export interface ReleaseRecord {
  surface: string;
  version: string;
  /** Название выкатки для людей: «Анкета и время рождения». */
  title: string;
  event: ReleaseEvent;
  /** `2026-11-10T18:42+03:00` — по Москве, до минуты. */
  at: string;
  /** Время взято из коммита, а не из момента выкатки. */
  approx: boolean;
  /** Коммит, который вышел в прод. */
  commit: string;
  /** Изменения релиза; у отката пусто. */
  changes: ReleaseChange[];
  /** Причина отката. */
  reason?: string;
}

/** Время записи по Москве: `2026-11-10T18:42+03:00`. */
export function releaseTime(at: Date): string {
  const stamp = logStamp(at);
  return `${stamp.slice(0, 10)}T${stamp.slice(11, 16)}${stamp.slice(20)}`;
}

/** Момент времени записи — для сортировки и сравнения. */
export function timeOf(at: string): number {
  return Date.parse(at.replace(APPROX, ''));
}

// ── строки таблицы ───────────────────────────────────────────────────────

export interface ReleaseRow {
  /** Ячейка времени как на странице: с пометкой `≈`, если время приблизительное. */
  at: string;
  surface: string;
  version: string;
  title: string;
  event: ReleaseEvent;
  zone: string;
  section: string;
  type: string;
  task: string;
  text: string;
}

export function rowsOf(record: ReleaseRecord): ReleaseRow[] {
  const base = { at: `${record.approx ? APPROX : ''}${record.at}`, surface: record.surface, version: record.version, title: record.title || NONE, event: record.event };
  if (record.event === 'откат') return [{ ...base, zone: NONE, section: NONE, type: NONE, task: NONE, text: record.reason ?? '' }];
  return record.changes.map((c) => ({ ...base, zone: c.zone, section: c.section ?? NONE, type: c.type, task: c.task ?? NONE, text: c.text }));
}

/** Строки одной записи идут подряд: по этому ключу они собираются обратно. Откатов одной версии может быть несколько — их различает время. */
export function recordKey(row: Pick<ReleaseRow, 'surface' | 'version' | 'event' | 'at'>): string {
  return row.event === 'откат' ? `${row.surface}\n${row.version}\n${row.event}\n${row.at}` : `${row.surface}\n${row.version}\n${row.event}`;
}

/**
 * Строки журнала в порядке страницы: записи — от новых к старым, строки внутри
 * записи — как их дали. Запись с тем же ключом из `added` заменяет прежнюю:
 * так повтор после оборванной записи и восстановление из тегов не плодят дубли.
 */
export function mergeRows(existing: readonly ReleaseRow[], added: readonly ReleaseRow[]): ReleaseRow[] {
  const replaced = new Set(added.map(recordKey));
  const groups = new Map<string, ReleaseRow[]>();
  for (const row of [...existing.filter((r) => !replaced.has(recordKey(r))), ...added]) {
    const key = recordKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((rows, order) => ({ rows, order, at: timeOf(rows[0].at) }))
    .sort((a, b) => b.at - a.at || a.order - b.order)
    .flatMap((g) => g.rows);
}

// ── страница ─────────────────────────────────────────────────────────────

const textNode = (value: string): PMNode => ({ type: 'text', text: value });
/** Текст ячейки — как есть: звёздочки и скобки в описании изменения не должны стать разметкой. */
const plainParagraph = (value: string): PMNode => ({ type: 'paragraph', ...(value ? { content: [textNode(value)] } : {}) });
const cell = (type: 'table_header' | 'table_cell', value: string): PMNode => ({ type, content: [plainParagraph(value)] });

/** Содержимое страницы журнала целиком. */
export function pageNodes(rows: readonly ReleaseRow[]): PMNode[] {
  const header: PMNode = { type: 'table_row', content: COLUMNS.map((name) => cell('table_header', name)) };
  const body = rows.map((r): PMNode => ({ type: 'table_row', content: [r.at, r.surface, r.version, r.title, r.event, r.zone, r.section, r.type, r.task, r.text].map((value) => cell('table_cell', value)) }));
  return [plainParagraph(NOTICE), { type: 'table', content: [header, ...body] }];
}

function plain(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => (n.type === 'text' ? (n.text ?? '') : plain(n.content)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowOf(cells: readonly string[], legacy: boolean): ReleaseRow | null {
  if (cells.length !== (legacy ? COLUMNS_V1 : COLUMNS).length) return null;
  const [at, surface, version, title, event, zone, section, type, task, text] = legacy ? [cells[0], cells[1], cells[2], NONE, cells[3], cells[4], NONE, cells[5], cells[6], cells[7]] : cells;
  if (!TIME_RE.test(at.replace(APPROX, '')) || !surface || !version || !text) return null;
  if (!(RELEASE_EVENTS as readonly string[]).includes(event)) return null;
  return { at, surface, version, title: title || NONE, event: event as ReleaseEvent, zone: zone || NONE, section: section || NONE, type: type || NONE, task: task || NONE, text };
}

const sameHeader = (names: readonly string[], columns: readonly string[]): boolean => names.length === columns.length && names.every((name, i) => name === columns[i]);

export type PageState =
  /** На странице ничего нет: журнал ещё не начат. */
  | { state: 'empty' }
  | { state: 'ok'; rows: ReleaseRow[] }
  /** Страница не похожа на журнал или повреждена; `salvaged` — строки, которые ещё читаются. */
  | { state: 'broken'; problem: string; salvaged: ReleaseRow[] };

/**
 * Что лежит на странице. Целой считается только страница из одной таблицы
 * журнала (перед ней — текст, после неё — ничего): две таблицы — след открытого
 * редактора, склеившего своё состояние с записанным, и дописывать в такую
 * страницу нельзя.
 */
export function readPage(nodes: readonly PMNode[]): PageState {
  const filled = nodes.filter((n) => n.type !== 'paragraph' || plain(n.content) !== '');
  if (filled.length === 0) return { state: 'empty' };
  const tables = filled.filter((n) => n.type === 'table');
  const salvaged: ReleaseRow[] = [];
  const seen = new Set<string>();
  let badRows = 0;
  let badHeader = false;
  for (const table of tables) {
    const [header, ...body] = table.content ?? [];
    const names = (header?.content ?? []).map((c) => plain(c.content));
    const legacy = sameHeader(names, COLUMNS_V1);
    if (!legacy && !sameHeader(names, COLUMNS)) badHeader = true;
    for (const row of body) {
      const parsed = rowOf((row.content ?? []).map((c) => plain(c.content)), legacy);
      if (!parsed) {
        badRows++;
        continue;
      }
      const line = JSON.stringify(parsed);
      if (!seen.has(line)) salvaged.push(parsed);
      seen.add(line);
    }
  }
  const broken = (problem: string): PageState => ({ state: 'broken', problem, salvaged });
  if (tables.length === 0) return broken('на странице нет таблицы журнала');
  if (tables.length > 1) return broken(`на странице ${tables.length} таблицы вместо одной — так бывает, когда страницу держали открытой в редакторе во время записи`);
  if (badHeader) return broken('шапка таблицы изменена');
  if (badRows > 0) return broken(`строк, которые не читаются: ${badRows} — в них не хватает ячеек, времени или события`);
  const index = filled.indexOf(tables[0]);
  if (index !== filled.length - 1) return broken('после таблицы журнала есть другое содержимое');
  if (filled.slice(0, index).some((n) => n.type !== 'paragraph')) return broken('перед таблицей журнала есть другое содержимое');
  if (index > 0 && !plain(filled[0].content).startsWith(NOTICE_START)) return broken('страница начинается не с пометки журнала');
  return { state: 'ok', rows: salvaged };
}

// ── ввод агента ──────────────────────────────────────────────────────────

export interface Dictionaries {
  zones: readonly string[];
  types: readonly string[];
}

/** Как найти задачу по тому, что написал агент: ключ для страницы или причина отказа. */
export type TaskResolver = (ref: string) => { ref: string } | { error: string };

export interface ParsedChanges {
  changes: ReleaseChange[];
  problems: string[];
}

const fromDictionary = (value: string, allowed: readonly string[]): string | undefined => allowed.find((a) => a.toLowerCase() === value.toLowerCase());

/**
 * Строки изменений: `<задача или -> | <зона> | <тип> | <раздел или -> | <что изменилось>`.
 * Пустые строки и строки с `#` пропускаются. Все замечания — разом: агент
 * исправляет ввод одним заходом.
 */
export function parseChanges(input: string, dict: Dictionaries, resolveTask: TaskResolver): ParsedChanges {
  const changes: ReleaseChange[] = [];
  const problems: string[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const where = `строка ${i + 1}`;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 5) {
      problems.push(`${where}: нужно пять частей через «|» — задача | зона | тип | раздел | что изменилось (в тексте «|» нельзя; нет задачи или раздела — «-»)`);
      continue;
    }
    const [taskRef, zoneRaw, typeRaw, sectionRaw, text] = parts;
    const section = !sectionRaw || sectionRaw === '-' || sectionRaw === NONE ? null : sectionRaw;
    const zone = fromDictionary(zoneRaw, dict.zones);
    const type = fromDictionary(typeRaw, dict.types);
    let task: string | null = null;
    if (!taskRef) problems.push(`${where}: нет задачи — ключ задачи или «-», если изменение без задачи`);
    else if (taskRef !== '-' && taskRef !== NONE) {
      const found = resolveTask(taskRef);
      if ('error' in found) problems.push(`${where}: ${found.error}`);
      else task = found.ref;
    }
    if (!zone) problems.push(`${where}: нет зоны «${zoneRaw}». Можно: ${dict.zones.join(', ')}`);
    if (!type) problems.push(`${where}: нет типа «${typeRaw}». Можно: ${dict.types.join(', ')}`);
    if (!text) problems.push(`${where}: не сказано, что изменилось`);
    if (zone && type && text) changes.push({ task, zone, type, section, text });
  }
  if (changes.length === 0 && problems.length === 0) problems.push('нет ни одной строки изменений');
  return { changes, problems };
}

/** Задачи выкатки, о которых во вводе нет ни строки. */
export function uncoveredTasks(changes: readonly ReleaseChange[], expected: readonly string[]): string[] {
  const covered = new Set(changes.map((c) => c.task).filter((t): t is string => t !== null));
  return expected.filter((ref) => !covered.has(ref));
}

// ── копия записи в теге ──────────────────────────────────────────────────

const RECORD_MARK = 'kaiten-release: ';

const RecordSchema = z.object({
  /** 1 — без названия выкатки и разделов; читается как запись с пустым названием. */
  v: z.union([z.literal(1), z.literal(2)]),
  surface: z.string().min(1),
  version: z.string().min(1),
  title: z.string().default(''),
  event: z.enum(RELEASE_EVENTS),
  at: z.string().regex(TIME_RE),
  approx: z.boolean().default(false),
  commit: z.string().min(1),
  changes: z.array(z.object({ task: z.string().nullable(), zone: z.string(), type: z.string(), section: z.string().nullable().default(null), text: z.string() })).default([]),
  reason: z.string().optional(),
});

/** Текст аннотации тега: строка для людей и запись целиком одной строкой JSON. */
export function recordMessage(record: ReleaseRecord): string {
  const subject = `${record.event === 'откат' ? 'Откат' : 'Релиз'} ${record.version} — ${record.surface}${record.title ? `: ${record.title}` : ''}`;
  return `${subject}\n\n${RECORD_MARK}${JSON.stringify({ v: 2, ...record })}\n`;
}

/** Запись из аннотации тега; `null` — в теге её нет или она не читается. */
export function parseRecordMessage(message: string): ReleaseRecord | null {
  const line = message.split('\n').find((l) => l.startsWith(RECORD_MARK));
  if (!line) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(RECORD_MARK.length));
  } catch {
    return null;
  }
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { v: _v, ...record } = parsed.data;
  return record;
}

/** Имя тега записи. У отката — своё: версию могли откатить не один раз. */
export function recordTagName(record: Pick<ReleaseRecord, 'version' | 'event'>, taken: ReadonlySet<string>): string {
  if (record.event === 'релиз') return `${RECORD_TAG_PREFIX}${record.version}`;
  const base = `${RECORD_TAG_PREFIX}${record.version}-rollback`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ── название и список изменений проекта ──────────────────────────────────

export function titleProblem(title: string): string | null {
  if (!title.trim()) return 'у выкатки нет названия — добавьте --title "<коротко, что вышло>"';
  if (/[|\n]/.test(title)) return 'в названии выкатки нельзя «|» и перенос строки';
  return null;
}

export interface ChangelogEntry {
  title: string;
  /** Пункты по разделам, в порядке файла; `section: null` — пункт вне разделов. */
  items: Array<{ section: string | null; text: string }>;
}

/**
 * Список изменений проекта для пользователей: `## v1.2.3 — 2026-11-09 — Название`,
 * разделы `### …`, пункты `- …` с продолжением на следующих строках. Версия →
 * название и пункты. «|» в тексте заменяется: он делит ячейки ввода.
 */
export function parseChangelog(text: string): Map<string, ChangelogEntry> {
  const out = new Map<string, ChangelogEntry>();
  let entry: ChangelogEntry | null = null;
  let section: string | null = null;
  const clean = (value: string): string => value.replace(/\s+/g, ' ').replaceAll('|', '/').trim();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^## \[?(v?\d[\w.-]*)\]?(?:\s+—\s+\d{4}-\d{2}-\d{2})?(?:\s+—\s+(.+))?$/.exec(line);
    if (head) {
      entry = { title: clean(head[2] ?? ''), items: [] };
      section = null;
      out.set(head[1], entry);
      continue;
    }
    if (!entry) continue;
    if (line.startsWith('## ')) {
      entry = null;
      continue;
    }
    if (line.startsWith('### ')) section = clean(line.slice(4)) || null;
    else if (/^[-*] /.test(line)) entry.items.push({ section, text: clean(line.slice(2)) });
    else if (line.trim() && !line.startsWith('#') && !line.startsWith('>')) {
      const last = entry.items.at(-1);
      // Продолжение пункта — с отступом; абзац без отступа под разделом — отдельная правка.
      if (last && last.section === section && /^\s/.test(line)) last.text = clean(`${last.text} ${line}`);
      else entry.items.push({ section, text: clean(line) });
    }
  }
  return out;
}

// ── версии ───────────────────────────────────────────────────────────────

/** Календарная версия: дата выкатки по Москве и её номер за день — `2026.11.19.1`. */
export function calendarVersion(at: Date, existing: readonly string[]): string {
  const day = logStamp(at).slice(0, 10).replaceAll('-', '.');
  const numbers = existing.filter((v) => v.startsWith(`${day}.`)).map((v) => Number(v.slice(day.length + 1))).filter((n) => Number.isInteger(n));
  return `${day}.${Math.max(0, ...numbers) + 1}`;
}

/** Ветка задачи из сообщения merge-коммита; `null` — это не слияние ветки. */
export function mergedBranch(subject: string): string | null {
  const m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject) ?? /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  return m ? m[1].replace(/^origin\//, '') : null;
}

// ── что не записано ──────────────────────────────────────────────────────

/** Выкатка в репозитории кода: версия с тегом или коммит ветки прода. */
export interface DeployPoint {
  /** Версия; у выкатки без версии (`calendar`) её выдаст запись. */
  version?: string;
  commit: string;
  /** Когда она появилась в репозитории: дата тега версии или коммита. */
  time: Date;
  subject?: string;
}

export interface RecordedTag {
  tag: string;
  commit: string;
  /** Когда сделана запись. */
  taggedAt: Date;
  record: ReleaseRecord | null;
}

export interface DeployFacts {
  recorded: readonly RecordedTag[];
  /** Выкатки без записи, от старых к новым. */
  pending: readonly DeployPoint[];
  /** Ветка прода стоит раньше последней записанной выкатки: её откатили, а записи об откате нет. */
  rolledBack: { version: string } | null;
}

/** Журнал поверхности начат, когда в репозитории есть хоть одна запись. */
export function journalStart(recorded: readonly RecordedTag[]): Date | null {
  return recorded.length === 0 ? null : new Date(Math.min(...recorded.map((r) => r.taggedAt.getTime())));
}

/**
 * Выкатки, из-за которых работу нельзя начинать: вышли после начала журнала,
 * записи нет, и «только что» уже прошло. Выкатки до начала журнала — история,
 * её заполняют отдельно и без спешки; свежую выкатку сейчас записывает тот,
 * кто её делал.
 */
export function overdue(facts: DeployFacts, now: Date): DeployPoint[] {
  const start = journalStart(facts.recorded);
  if (!start) return [];
  return facts.pending.filter((p) => p.time.getTime() > start.getTime() && now.getTime() - p.time.getTime() > FRESH_MS);
}

/** Откуда взять время записи. */
export type TimeChoice = { at: string; approx: boolean } | { problem: string };

/**
 * Время записи: свежая выкатка — момент запуска команды; давняя — только по
 * явному выбору: `--missed` (время из коммита, приблизительно) или `--now`
 * (коммит давний, а в прод вышел только что).
 */
export function chooseTime(point: DeployPoint, now: Date, flags: { missed: boolean; now: boolean }): TimeChoice {
  if (flags.missed && flags.now) return { problem: 'флаги --missed и --now вместе не ставят: выкатка вышла либо раньше, либо только что' };
  if (flags.missed) return { at: releaseTime(point.time), approx: true };
  const fresh = now.getTime() - point.time.getTime() <= FRESH_MS;
  if (fresh || flags.now) return { at: releaseTime(now), approx: false };
  return {
    problem:
      `коммит выкатки сделан ${releaseTime(point.time)} — давно. Если выкатка вышла в прод раньше, добавьте --missed: время возьмётся из коммита с пометкой «${APPROX}». ` +
      'Если она вышла только что — добавьте --now',
  };
}
