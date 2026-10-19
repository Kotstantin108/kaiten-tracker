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

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyOp, logStamp, type Op, type OpResult, type TaskTexts } from './core/task-ops.js';
import { git, gitNetwork, gitText, isStore, listEntries, readBlobs, revOrNull, storeBranch, StoreError, type StoreErrorKind } from './task-store.js';

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
  /** Отправляемое сейчас: push этого коммита несёт операции до `lastSeq` включительно. */
  inflight?: { head: string; lastSeq: number };
  /** Ошибки последнего шага Kaiten: заменяются каждым шагом, показываются один раз. */
  kaiten?: { errors: FailedEntry[]; shown: boolean };
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
  // Замена целиком (rename заменяет файл и на Windows): оборванная запись не оставит полжурнала.
  renameSync(tmp, path);
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
  // Несколько агентов на одной машине пишут в одно хранилище: под нагрузкой сосед держит замок
  // десятки секунд: пересборка неотправленных операций — несколько вызовов git на каждую, а git на
  // Windows медленный. Живьём 30.09: шесть агентов разом — 10 с и 30 с ожидания давали «занято».
  // Умерший владелец замка снимается сразу (по pid), поэтому долгое ожидание ничего не подвешивает.
  const waitMs = options.waitMs ?? 120_000;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const started = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      // Занят — только EEXIST; нет папки или нет прав — ждать бессмысленно.
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw new StoreError('not-store');
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

/**
 * Замок для асинхронного кода (шаг Kaiten): ждёт через таймер, не блокируя
 * цикл событий, и снимается в `finally` — после всех `await`, а не на
 * возврате промиса, как было бы с `withLock`.
 */
export async function withLockAsync<T>(store: string, name: string, fn: () => Promise<T>, options: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const path = join(store, name);
  const waitMs = options.waitMs ?? 120_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      break;
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw new StoreError('not-store');
      let stale = true;
      try {
        const [pid] = readFileSync(path, 'utf8').split(' ');
        stale = !alive(Number(pid)) || Date.now() - statSync(path).mtimeMs > staleMs;
      } catch {
        stale = false;
      }
      if (stale) rmSync(path, { force: true });
      else if (Date.now() - started > waitMs) throw new StoreError('busy');
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}

/**
 * Взять замок, не дожидаясь: `null` — занят живым процессом. Возвращает функцию,
 * которая его снимает. Замок умершего процесса (или старше `staleMs`) снимается.
 */
export function tryLock(store: string, name: string, staleMs = 10 * 60_000): (() => void) | null {
  const path = join(store, name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) return null;
      try {
        const [pid] = readFileSync(path, 'utf8').split(' ');
        if (alive(Number(pid)) && Date.now() - statSync(path).mtimeMs <= staleMs) return null;
      } catch {
        return null; // Замок как раз снимают или ставят — считаем занятым.
      }
      rmSync(path, { force: true });
    }
  }
  return null;
}

/**
 * Очередь фоновых отправок — не длиннее одного. Несколько агентов на одной
 * машине пишут часто, и каждый запускает свою отправку; если бы все они ждали
 * замок по очереди, очередь росла бы быстрее, чем разбирается (живьём 30.09:
 * шесть агентов — `pull` не дождался замка). Поэтому фоновая отправка сначала
 * встаёт в очередь (`*-queue.lock`): место занято — выходит, потому что тот,
 * кто ждёт, ещё не начал и заберёт из журнала и её операцию тоже. Занявший
 * место освобождает его, как только получил сам замок, — до чтения журнала.
 */
export const SEND_QUEUE = 'kaiten-send-queue.lock';
export const KAITEN_QUEUE = 'kaiten-sync-queue.lock';

/** Шаг Kaiten: один на хранилище — иначе два отправителя создали бы по карточке на задачу. */
export const KAITEN_LOCK = 'kaiten-sync.lock';

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
      const result = applyOp(entry.op, texts as TaskTexts, { date: entry.date, stamp: logStamp(new Date(entry.at)) });
      if ('error' in result) {
        out.failed.push({ entry, reason: result.error });
        continue;
      }
      // Вложение — готовый объект хранилища; пропал (хранилище загружали заново) — операция не применяется.
      if (result.changes.some((c) => c.blob !== undefined && !hasObject(store, c.blob))) {
        out.failed.push({ entry, reason: 'содержимое вложения не сохранилось — приложите файл ещё раз' });
        continue;
      }
      const applied = { entry, result };
      out.applied.push(applied);
      if (result.changes.length === 0) continue;
      // `--index-info` работает и без рабочей копии (`--force-remove` — нет):
      // режим 0 убирает файл из индекса. Записи через NUL — имена не экранируются.
      const records: string[] = [];
      for (const change of result.changes) {
        if (change.blob !== undefined) {
          records.push(`100644 ${change.blob}\t${change.path}`);
        } else if (change.text === null) {
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
      // Вложение с тем же содержимым дерево не меняет: пустой коммит не нужен, и отправлять нечего.
      if (out.head && gitText(store, ['rev-parse', `${out.head}^{tree}`]) === tree) {
        applied.result = { ...result, changes: [] };
        continue;
      }
      const parent = out.head ? ['-p', out.head] : [];
      out.head = gitText(store, ['commit-tree', tree, ...parent, '-m', `kaiten: ${result.summary}`]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function hasObject(store: string, sha: string): boolean {
  try {
    git(store, ['cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

/** Положить содержимое вложения в хранилище объектом; возвращает его sha. Без сети, ветку не меняет. */
export function storeBlob(store: string, content: Buffer): string {
  return gitText(store, ['hash-object', '-w', '--stdin'], content);
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

export interface SyncOptions {
  now?: () => Date;
  /** Вызывается, когда замок отправки получен, — до чтения журнала (освободить место в очереди). */
  onLocked?: () => void;
  /** Только для тестов: вызывается перед push (чужой push — гонка) и после него (обрыв). */
  beforePush?: () => void;
  afterPush?: () => void;
}

const MAX_ATTEMPTS = 5;

/**
 * Текст, который иначе пропал бы вместе с не применённой операцией (новая
 * задача, правка, запись журнала), — во временный файл: вне репозитория кода,
 * и человек может применить его заново.
 */
function keepText(entry: JournalEntry): string | null {
  const op = entry.op;
  const text = op.kind === 'new' || op.kind === 'edit' || op.kind === 'log' ? op.text : null;
  if (text === null) return null;
  const path = join(tmpdir(), `kaiten-${op.kind}-${entry.seq}-${Date.now()}.md`);
  writeFileSync(path, text);
  return path;
}

/**
 * Забрать общее, пересобрать локальное, отправить неотправленное.
 *
 * Отправитель один: замок `kaiten-send.lock` берут и фоновая отправка, и
 * `kaiten pull` — иначе вторая пересобрала бы поверх уже отправленного и
 * применила операции дважды. Сетевые шаги — вне замка журнала: команды
 * записи сеть не ждут.
 *
 * Обрыв между push и записью журнала: перед push в журнале метка
 * `inflight` (что отправляем и до какой операции). Следующая отправка,
 * увидев метку, проверяет, дошёл ли тот push, и если да — выбрасывает уже
 * отправленные операции, а не применяет их второй раз.
 */
export function syncStore(store: string, options: SyncOptions = {}): SyncResult {
  if (!isStore(store)) throw new StoreError('not-store');
  return withLock(
    store,
    SEND_LOCK,
    () => {
      options.onLocked?.();
      return syncLocked(store, options);
    },
    { waitMs: 180_000, staleMs: 5 * 60_000 },
  );
}

function syncLocked(store: string, options: SyncOptions): SyncResult {
  const now = options.now ?? (() => new Date());
  const branch = storeBranch(store);
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const outcome: SyncResult = { changed: false, sent: 0, failed: [] };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      gitNetwork(store, ['fetch', '--quiet', '--prune', 'origin']);
    } catch (error) {
      if (error instanceof StoreError) noteProblem(store, error.kind, now());
      throw error;
    }

    const plan = withLock(store, JOURNAL_LOCK, () => {
      const journal = readJournal(store);
      const before = revOrNull(store, local);
      const base = revOrNull(store, remote);
      if (journal.inflight) {
        const landed = base !== null && isAncestor(store, journal.inflight.head, base);
        if (landed) {
          const done = journal.inflight.lastSeq;
          outcome.sent += journal.pending.filter((e) => e.seq <= done).length;
          journal.pending = journal.pending.filter((e) => e.seq > done);
        }
        delete journal.inflight;
      }
      const rebuilt = rebuild(store, base, journal.pending);
      setRef(store, local, rebuilt.head, before);
      if (rebuilt.head !== before) outcome.changed = true;
      const failed = rebuilt.failed.map((f) => {
        const kept = keepText(f.entry);
        return { what: f.entry.what, reason: kept ? `${f.reason}; текст сохранён в ${kept}` : f.reason, at: now().toISOString() };
      });
      outcome.failed.push(...failed);
      journal.failed.push(...failed);
      // Операции, которые ничего не меняют на свежем состоянии, отправлять незачем.
      journal.pending = rebuilt.applied.filter((a) => a.result.changes.length > 0).map((a) => a.entry);
      const lastSeq = journal.pending.at(-1)?.seq ?? 0;
      if (journal.pending.length > 0 && rebuilt.head !== null) journal.inflight = { head: rebuilt.head, lastSeq };
      writeJournal(store, journal);
      return { head: rebuilt.head, base, lastSeq, count: journal.pending.length };
    });

    if (plan.count === 0 || plan.head === null || plan.head === plan.base) {
      clearProblem(store);
      return outcome;
    }

    options.beforePush?.();
    try {
      gitNetwork(store, ['push', '--quiet', 'origin', `${plan.head}:refs/heads/${branch}`]);
    } catch (error) {
      if (error instanceof StoreError && error.kind === 'rejected') continue;
      if (error instanceof StoreError) noteProblem(store, error.kind, now());
      throw error;
    }
    options.afterPush?.();

    const more = withLock(store, JOURNAL_LOCK, () => {
      const journal = readJournal(store);
      journal.pending = journal.pending.filter((e) => e.seq > plan.lastSeq);
      delete journal.inflight;
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

function isAncestor(store: string, ancestor: string, of: string): boolean {
  try {
    git(store, ['merge-base', '--is-ancestor', ancestor, of]);
    return true;
  } catch {
    return false;
  }
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

/** Отправка в фоне: тот же `syncStore` — один отправитель за раз, следующий ждёт. */
export function sendInBackground(store: string): void {
  const leaveQueue = tryLock(store, SEND_QUEUE);
  // В очереди уже ждёт другая отправка: она ещё не читала журнал и заберёт всё записанное.
  if (!leaveQueue) return;
  try {
    syncStore(store, { onLocked: leaveQueue });
  } finally {
    leaveQueue();
  }
}

// ── что сказать человеку ─────────────────────────────────────────────────

export interface Notices {
  failed: FailedEntry[];
  /** Что не дошло до Kaiten на последнем шаге (файлы при этом записаны). */
  kaiten: FailedEntry[];
  pending: number;
  problem: StoreErrorKind | null;
}

/**
 * Итог шага Kaiten: ошибки заменяют прошлые (постоянная ошибка не копится и
 * не повторяется после каждой команды), пустой итог стирает их.
 */
export function setKaitenErrors(store: string, errors: readonly Omit<FailedEntry, 'at'>[], at = new Date()): void {
  withLock(store, JOURNAL_LOCK, () => {
    const journal = readJournal(store);
    const next = errors.map((e) => ({ ...e, at: at.toISOString() }));
    const same = JSON.stringify(journal.kaiten?.errors.map(({ what, reason }) => [what, reason]) ?? []) === JSON.stringify(next.map(({ what, reason }) => [what, reason]));
    if (same && journal.kaiten) return;
    journal.kaiten = next.length > 0 ? { errors: next, shown: false } : undefined;
    if (!journal.kaiten) delete journal.kaiten;
    writeJournal(store, journal);
  });
}

/** Сообщить следующей команде о том, что не удалось. */
export function noteFailures(store: string, failures: readonly Omit<FailedEntry, 'at'>[], at = new Date()): void {
  if (failures.length === 0) return;
  withLock(store, JOURNAL_LOCK, () => {
    const journal = readJournal(store);
    journal.failed.push(...failures.map((f) => ({ ...f, at: at.toISOString() })));
    writeJournal(store, journal);
  });
}

/** Не применённые операции (показываются один раз) и неотправленное. */
export function takeNotices(store: string): Notices {
  if (!existsSync(join(store, JOURNAL))) return { failed: [], kaiten: [], pending: 0, problem: null };
  // Сообщения прошлых команд не стоят ожидания: замок занят — команда идёт дальше, скажем в следующий раз.
  return withLock(
    store,
    JOURNAL_LOCK,
    () => {
    const journal = readJournal(store);
    const kaiten = journal.kaiten && !journal.kaiten.shown ? journal.kaiten.errors : [];
    const notices: Notices = { failed: journal.failed, kaiten, pending: journal.pending.length, problem: journal.sendProblem?.kind ?? null };
    if (journal.failed.length > 0 || kaiten.length > 0) {
      journal.failed = [];
      if (journal.kaiten) journal.kaiten.shown = true;
      writeJournal(store, journal);
    }
    return notices;
    },
    { waitMs: 2_000 },
  );
}
