/**
 * Запись в хранилище задач без рабочей копии и отправка общим.
 *
 * ЖУРНАЛ ОПЕРАЦИЙ. Команда записи сохраняет не diff, а намерение (`Op` из
 * `core/task-ops.ts`) в журнал `kaiten-journal.json` внутри хранилища и сразу
 * строит из него коммит поверх локальной ветки — чтение видит изменение
 * мгновенно. Инвариант: локальная ветка = общая (`origin/<ветка>`) + коммиты,
 * построенные из неотправленных операций журнала по порядку.
 *
 * ОТПРАВКА (`syncStore`): забрать общее → под замком пересобрать локальную
 * ветку заново: общая + операции журнала, применённые к свежему состоянию →
 * отправить. Отвергли (кто-то успел раньше) — повторить. Операция, которая к
 * свежему состоянию больше не применяется (пункт удалили, задачу закрыли),
 * переходит в `failed` — следующая команда `kaiten` скажет об этом словами
 * задачи. Так нет rebase без рабочей копии: пересобрать проще, чем перебазировать.
 *
 * Отправку делает фоновый процесс (`kaiten __send`, решение владельца 28.09:
 * агент не ждёт сеть); `kaiten pull` делает её сразу. Одновременно работает
 * один отправитель — замок `kaiten-send.lock`; журнал и ветку меняют только
 * под замком `kaiten.lock`, коротко и без сети.
 *
 * Коммит без рабочей копии: `hash-object -w` → временный индекс
 * (`GIT_INDEX_FILE`, `read-tree`, `update-index`) → `write-tree` →
 * `commit-tree` → `update-ref <ref> <новый> <старый>` (сравнение-и-замена).
 * Автор — git-имя разработчика: агент работает через его CLI (Q33).
 */

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyOp, type Op, type OpResult, type TaskTexts } from './core/task-ops.js';
import { git, gitText, listEntries, readBlobs, revOrNull, storeBranch, StoreError, type StoreErrorKind } from './task-store.js';

// ── журнал ───────────────────────────────────────────────────────────────

export interface JournalEntry {
  seq: number;
  /** Когда записано, ISO. */
  at: string;
  /** Дата операции `YYYY-MM-DD` — её получают `updated` и журнал задачи при любом пересчёте. */
  date: string;
  op: Op;
  /** Что это было — словами задачи, для сообщений: «отметка пунктов в PRJ-123». */
  what: string;
}

export interface FailedEntry {
  what: string;
  reason: string;
  at: string;
}

export interface Journal {
  next: number;
  pending: JournalEntry[];
  failed: FailedEntry[];
  /** Последняя неудачная отправка: вид ошибки и когда. Успешная — стирает. */
  sendProblem?: { kind: StoreErrorKind; at: string };
}

const JOURNAL = 'kaiten-journal.json';

export function readJournal(store: string): Journal {
  const path = join(store, JOURNAL);
  if (!existsSync(path)) return { next: 1, pending: [], failed: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as Journal;
}

function writeJournal(store: string, journal: Journal): void {
  const path = join(store, JOURNAL);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  // Замена целиком: оборванная запись не оставит полжурнала.
  writeFileSync(path, readFileSync(tmp));
  rmSync(tmp, { force: true });
}

export function hasPending(store: string): boolean {
  return existsSync(join(store, JOURNAL)) && readJournal(store).pending.length > 0;
}

// ── замки ────────────────────────────────────────────────────────────────

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Замок-файл с pid владельца. Брошенный замок (процесс умер или замок старше
 * `staleMs`) снимается: убитый отправитель не должен останавливать запись навсегда.
 */
export function withLock<T>(store: string, name: string, fn: () => T, options: { waitMs?: number; staleMs?: number } = {}): T {
  const path = join(store, name);
  const waitMs = options.waitMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(path, 'wx');
    } catch {
      let stale = true;
      try {
        const [pid] = readFileSync(path, 'utf8').split(' ');
        stale = !alive(Number(pid)) || Date.now() - statSync(path).mtimeMs > staleMs;
      } catch {
        stale = false; // Замок как раз снимают — попробуем ещё раз.
      }
      if (stale) rmSync(path, { force: true });
      else if (Date.now() - started > waitMs) throw new StoreError('busy');
      else sleep(50);
    }
  }
  writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
  closeSync(fd);
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

const JOURNAL_LOCK = 'kaiten.lock';
const SEND_LOCK = 'kaiten-send.lock';

// ── коммиты без рабочей копии ────────────────────────────────────────────

const TASK_TEXT_RE = /^(?:active|archive)\/.+\.md$/;

function loadTexts(store: string, rev: string | null): Map<string, string> {
  const texts = new Map<string, string>();
  if (!rev) return texts;
  const entries = listEntries(store, rev).filter((e) => TASK_TEXT_RE.test(e.path));
  const blobs = readBlobs(
    store,
    entries.map((e) => e.sha),
  );
  for (const e of entries) texts.set(e.path, blobs.get(e.sha)?.toString('utf8') ?? '');
  return texts;
}

export interface Rebuilt {
  head: string | null;
  applied: Array<{ entry: JournalEntry; result: Extract<OpResult, { changes: unknown }> }>;
  failed: Array<{ entry: JournalEntry; reason: string }>;
}

/** Операции по порядку поверх `base`: коммит на каждую, что-то изменившую. */
export function rebuild(store: string, base: string | null, entries: readonly JournalEntry[]): Rebuilt {
  const out: Rebuilt = { head: base, applied: [], failed: [] };
  if (entries.length === 0) return out;
  const texts = loadTexts(store, base);
  const tmp = mkdtempSync(join(tmpdir(), 'kaiten-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    git(store, base ? ['read-tree', base] : ['read-tree', '--empty'], undefined, env);
    for (const entry of entries) {
      const result = applyOp(entry.op, texts as TaskTexts, { date: entry.date });
      if ('error' in result) {
        out.failed.push({ entry, reason: result.error });
        continue;
      }
      out.applied.push({ entry, result });
      if (result.changes.length === 0) continue;
      // `--index-info` работает и без рабочей копии (`--force-remove` — нет):
      // режим 0 убирает файл из индекса. Записи через NUL — имена не экранируются.
      const records: string[] = [];
      for (const change of result.changes) {
        if (change.text === null) {
          records.push(`0 ${'0'.repeat(40)}\t${change.path}`);
          texts.delete(change.path);
        } else {
          const sha = gitText(store, ['hash-object', '-w', '--stdin'], change.text);
          records.push(`100644 ${sha}\t${change.path}`);
          texts.set(change.path, change.text);
        }
      }
      git(store, ['update-index', '-z', '--index-info'], `${records.join('\0')}\0`, env);
      const tree = gitText(store, ['write-tree'], undefined, env);
      const parent = out.head ? ['-p', out.head] : [];
      out.head = gitText(store, ['commit-tree', tree, ...parent, '-m', `kaiten: ${result.summary}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function setRef(store: string, ref: string, sha: string | null, expected: string | null): void {
  if (sha === expected) return;
  if (sha === null) git(store, ['update-ref', '-d', ref]);
  else git(store, ['update-ref', ref, sha, expected ?? '']);
}

// ── запись операции ──────────────────────────────────────────────────────

export type Recorded = { summary: string; warnings: string[]; changed: boolean } | { error: string };

/** Применить операцию к локальному состоянию и записать в журнал. Без сети. */
export function recordOp(store: string, op: Op, what: string, date: string, now = new Date()): Recorded {
  return withLock(store, JOURNAL_LOCK, () => {
    const ref = `refs/heads/${storeBranch(store)}`;
    const head = revOrNull(store, ref);
    const journal = readJournal(store);
    const entry: JournalEntry = { seq: journal.next, at: now.toISOString(), date, op, what };
    const result = rebuild(store, head, [entry]);
    if (result.failed.length > 0) return { error: result.failed[0].reason };
    const applied = result.applied[0].result;
    if (result.head === head) return { summary: applied.summary, warnings: applied.warnings, changed: false };
    setRef(store, ref, result.head, head);
    journal.next += 1;
    journal.pending.push(entry);
    writeJournal(store, journal);
    return { summary: applied.summary, warnings: applied.warnings, changed: true };
  });
}

// ── отправка ─────────────────────────────────────────────────────────────

export interface SyncResult {
  /** Изменилось ли локальное состояние задач (пришло чужое или пересобралось). */
  changed: boolean;
  sent: number;
  failed: FailedEntry[];
}

const MAX_ATTEMPTS = 5;

/**
 * Забрать общее, пересобрать локальное, отправить неотправленное. Сетевые
 * шаги — вне замка журнала: команды записи не ждут сеть.
 */
export function syncStore(store: string, now: () => Date = () => new Date()): SyncResult {
  const branch = storeBranch(store);
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const outcome: SyncResult = { changed: false, sent: 0, failed: [] };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      git(store, ['fetch', '--quiet', '--prune', 'origin']);
    } catch (error) {
      if (error instanceof StoreError) noteProblem(store, error.kind, now());
      throw error;
    }

    const plan = withLock(store, JOURNAL_LOCK, () => {
      const journal = readJournal(store);
      const before = revOrNull(store, local);
      const base = revOrNull(store, remote);
      const rebuilt = rebuild(store, base, journal.pending);
      setRef(store, local, rebuilt.head, before);
      if (rebuilt.head !== before) outcome.changed = true;
      const failed = rebuilt.failed.map((f) => ({ what: f.entry.what, reason: f.reason, at: now().toISOString() }));
      outcome.failed.push(...failed);
      journal.failed.push(...failed);
      // Операции, которые ничего не меняют на свежем состоянии, отправлять незачем.
      journal.pending = rebuilt.applied.filter((a) => a.result.changes.length > 0).map((a) => a.entry);
      writeJournal(store, journal);
      return { head: rebuilt.head, base, lastSeq: journal.pending.at(-1)?.seq ?? 0, count: journal.pending.length };
    });

    if (plan.count === 0 || plan.head === null || plan.head === plan.base) {
      clearProblem(store);
      return outcome;
    }

    try {
      git(store, ['push', '--quiet', 'origin', `${plan.head}:refs/heads/${branch}`]);
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'rejected') continue;
      if (error instanceof StoreError) noteProblem(store, error.kind, now());
      throw error;
    }

    const more = withLock(store, JOURNAL_LOCK, () => {
      const journal = readJournal(store);
      journal.pending = journal.pending.filter((e) => e.seq > plan.lastSeq);
      delete journal.sendProblem;
      writeJournal(store, journal);
      git(store, ['update-ref', remote, plan.head ?? '']);
      return journal.pending.length;
    });
    outcome.sent += plan.count;
    // Пока отправляли, могли записать ещё — отправим и их тем же проходом.
    if (more === 0) return outcome;
  }
  noteProblem(store, 'rejected', now());
  throw new StoreError('rejected');
}

function noteProblem(store: string, kind: StoreErrorKind, at: Date): void {
  withLock(store, JOURNAL_LOCK, () => {
    const journal = readJournal(store);
    journal.sendProblem = { kind, at: at.toISOString() };
    writeJournal(store, journal);
  });
}

function clearProblem(store: string): void {
  withLock(store, JOURNAL_LOCK, () => {
    const journal = readJournal(store);
    if (!journal.sendProblem) return;
    delete journal.sendProblem;
    writeJournal(store, journal);
  });
}

/** Отправка в фоне: один отправитель за раз; следующий ждёт и отправит накопившееся. */
export function sendInBackground(store: string): void {
  withLock(store, SEND_LOCK, () => syncStore(store), { waitMs: 60_000, staleMs: 5 * 60_000 });
}

// ── что сказать человеку ─────────────────────────────────────────────────

export interface Notices {
  failed: FailedEntry[];
  pending: number;
  problem: StoreErrorKind | null;
}

/** Не применённые операции (показываются один раз) и неотправленное. */
export function takeNotices(store: string): Notices {
  if (!existsSync(join(store, JOURNAL))) return { failed: [], pending: 0, problem: null };
  return withLock(store, JOURNAL_LOCK, () => {
    const journal = readJournal(store);
    const notices: Notices = { failed: journal.failed, pending: journal.pending.length, problem: journal.sendProblem?.kind ?? null };
    if (journal.failed.length > 0) {
      journal.failed = [];
      writeJournal(store, journal);
    }
    return notices;
  });
}
