/**
 * `kaiten verify <задача>` — прогнать проверки проекта перед сдачей работы, и
 * гейты `kaiten review` (`core/review-gates.ts`, `docs/review-gates.md`).
 *
 * Что запускать, называет только `kaiten.json` репозитория задач
 * (`review.checks`): ни из аргументов, ни из текста задачи строка команды не
 * берётся — агент не может подменить проверку. Проверки идут по порядку в корне
 * репозитория кода, первая упавшая останавливает прогон.
 *
 * Свидетельство привязано к коммиту: прогон — только на чистой рабочей копии,
 * и итог записывается вместе с хешем `HEAD`. Проверка, которая сама изменила
 * рабочую копию (автоисправление линтера, снимки тестов), свидетельства не
 * даёт: проверено было не то, что лежит в коммите.
 *
 * Вывод упавшей проверки — агенту, хвостом; в журнал задачи — только итог: в
 * выводе могут быть секреты окружения, а журнал виден по ссылке из карточки.
 *
 * Git здесь — репозиторий кода, из которого запущена команда.
 */

import { spawn, spawnSync } from 'node:child_process';

import { reviewGates, type ReviewCheck, type ReviewGates } from './config.js';
import { checksGateProblem, docsDecision, evidenceCovers, formatDuration, gatesApply, outputTail, shortCommit, type CheckResult } from './core/review-gates.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { currentPerson, findTask, loadTasks, parse, printNotices, resolveContext, TASK_REF_HELP, UsageError, type Context } from './kaiten-cli.js';
import { git } from './kaiten-start.js';
import { commit } from './kaiten-write.js';

export const VERIFY_HELP = `kaiten verify <задача> — прогнать проверки проекта перед сдачей на ревью.

Запускает проверки, которые проект требует перед ревью (типы, линтер, тесты —
у каждого проекта свои), по порядку, до первой упавшей. Итог и коммит, на
котором они шли, записывает в задачу: kaiten review принимает работу только с
успешным прогоном на текущем коммите ветки. Поэтому сначала коммит, потом
verify: новый коммит после прогона — и его нужно повторить.

Запускайте из репозитория задачи, на её ветке, без незакоммиченных изменений.
Проверка упала — команда покажет конец её вывода: исправьте, закоммитьте,
запустите снова.
${TASK_REF_HELP}

Пример:
  kaiten verify PRJ-123
`;

// ── git репозитория кода ─────────────────────────────────────────────────

export interface WorkState {
  /** Корень репозитория кода. */
  root: string;
  /** Текущая ветка; `null` — HEAD не на ветке. */
  branch: string | null;
  /** Полный хеш текущего коммита. */
  head: string;
  /** Изменённые и новые файлы, которых нет в коммите. */
  dirty: string[];
}

/** Состояние рабочей копии; ошибка — словами для человека. */
export function workState(workDir: string): WorkState | { error: string } {
  const root = git(workDir, ['rev-parse', '--show-toplevel']);
  if (!root.ok || !root.out) return { error: 'эта папка — не репозиторий git' };
  const head = git(workDir, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok || !head.out) return { error: 'в репозитории ещё нет ни одного коммита' };
  const status = git(workDir, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=normal']);
  if (!status.ok) return { error: 'git не показал состояние рабочей копии' };
  // Строка — «XY путь»; первый пробел первой строки съеден обрезкой вывода, поэтому не по позиции.
  const dirty = status.out
    .split('\n')
    .map((line) => line.replace(/^\s*[A-Z?!]{1,2}\s+/, '').trim())
    .filter(Boolean);
  return { root: root.out, branch: git(workDir, ['branch', '--show-current']).out || null, head: head.out, dirty };
}

/**
 * Файлы, изменённые в ветке от общего предка с основной веткой до `HEAD`.
 * Основная — с сервера (`origin/<ветка>`), если она там есть: локальная могла
 * отстать. Сеть не трогаем: гейт локальный. `null` — основной ветки нет.
 */
export function branchChanges(workDir: string, mainBranch: string): string[] | null {
  const ref = [`refs/remotes/origin/${mainBranch}`, `refs/heads/${mainBranch}`].find((r) => git(workDir, ['rev-parse', '--verify', '--quiet', r]).ok);
  if (!ref) return null;
  const base = git(workDir, ['merge-base', 'HEAD', ref]);
  if (!base.ok || !base.out) return null;
  const diff = git(workDir, ['-c', 'core.quotepath=false', 'diff', '--name-only', base.out, 'HEAD']);
  if (!diff.ok) return null;
  return diff.out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Что мешает считать рабочую копию работой по этой задаче; `null` — ничего. */
function placeProblem(ctx: Context, task: TaskRecord, state: WorkState): string | null {
  if (task.fm.repo !== ctx.currentRepo) return `задача для репозитория ${task.fm.repo ?? '(не указан)'}, а вы в ${ctx.currentRepo}: работайте с ней оттуда`;
  if (task.fm.branch && state.branch !== task.fm.branch) {
    return `вы ${state.branch ? `на ветке ${state.branch}` : 'не на ветке'}, а работа по задаче — в ветке ${task.fm.branch}. Переключитесь: git switch ${task.fm.branch}`;
  }
  return null;
}

// ── гейты kaiten review ──────────────────────────────────────────────────

/**
 * Гейты сдачи для `kaiten review`: документация, затем проверки. Проект их не
 * задал или задача без кода (spike) — пусто, и git не трогается. Не пройден —
 * отказ до карточки и записи. Возвращает записи для журнала.
 *
 * Документация — первой: её правка — новый коммит, после которого проверки всё
 * равно пришлось бы гнать заново.
 */
export function reviewGateNotes(ctx: Context, task: TaskRecord, noIngest: string | undefined): string[] {
  // Гейты — репозитория задачи, а не того, откуда запущена команда: из соседнего репозитория без проверок её не сдать.
  const gates = reviewGates(ctx.loaded.project, task.fm.repo ?? ctx.currentRepo);
  if (!gatesApply(task.fm.type) || (gates.checks.length === 0 && gates.docs.length === 0)) return [];
  const ref = refOf(task);
  const state = workState(ctx.workDir);
  if ('error' in state) throw new UsageError(`Не записано: ${state.error} — работу по задаче ${ref} сдают из её репозитория кода.`, 1);
  const place = placeProblem(ctx, task, state);
  if (place) throw new UsageError(`Не записано: ${place}.`, 1);

  const notes: string[] = [];
  if (gates.docs.length > 0) {
    const decision = docsDecision({ ref, globs: gates.docs, changed: branchChanges(ctx.workDir, gates.mainBranch), mainBranch: gates.mainBranch, noIngest });
    if ('problem' in decision) throw new UsageError(`Не записано: ${decision.problem}`, 1);
    notes.push(decision.note);
  }
  if (gates.checks.length > 0) {
    const problem = checksGateProblem({ ref, head: state.head, dirty: state.dirty.length > 0, evidence: task.fm.checks, wanted: gates.checks.map((c) => c.name) });
    if (problem) throw new UsageError(`Не записано: ${problem}`, 1);
    notes.push(`проверки пройдены на коммите ${shortCommit(state.head)}`);
  }
  return notes;
}

// ── запуск проверки ──────────────────────────────────────────────────────

/** Сколько вывода проверки держим в памяти: хвост показывается, начало не нужно. */
const OUTPUT_KEEP = 256 * 1024;

function killTree(pid: number): void {
  try {
    // Проверка — оболочка с потомками (npm → node → …): убивать нужно всех.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // Уже завершилась.
  }
}

export interface CheckRun {
  ok: boolean;
  ms: number;
  timedOut: boolean;
  output: string;
}

/** Запустить одну проверку в корне репозитория. Вывод — вместе, в порядке появления. */
export function runCheck(check: ReviewCheck, cwd: string): Promise<CheckRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    const child = spawn(check.run, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env: process.env });
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEEP);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, check.timeoutMin * 60_000);
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      resolve({ ok: ok && !timedOut, ms: Date.now() - started, timedOut, output });
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(false);
    });
    child.on('close', (code) => finish(code === 0));
  });
}

// ── команда ──────────────────────────────────────────────────────────────

/** Прогон проверок по задаче. `say` — куда печатать ход; тесты подменяют. */
export async function verifyTask(ctx: Context, taskRef: string, say: (line: string) => void = console.log): Promise<void> {
  // Кто вы — до прогона: запись журнала без автора не делается.
  currentPerson(ctx.loaded.people);
  const task = findTask(loadTasks(ctx).index, taskRef);
  const ref = refOf(task);
  const gates: ReviewGates = reviewGates(ctx.loaded.project, task.fm.repo ?? ctx.currentRepo);
  if (!gatesApply(task.fm.type)) {
    say(`Проверки проекта — для задач с кодом; у задачи типа ${task.fm.type} их нет. Запускать нечего.`);
    return;
  }
  if (gates.checks.length === 0) {
    say('В этом проекте проверки перед ревью не заданы. Запускать нечего.');
    return;
  }
  if (task.fm.status !== 'in-progress') {
    throw new UsageError(`Проверки не запущены: задача ${ref} в статусе ${task.fm.status}, а их запускают по задаче в работе${task.fm.status === 'review' ? ' — на ревью она уже сдана' : ''}.`, 1);
  }
  const state = workState(ctx.workDir);
  if ('error' in state) throw new UsageError(`Проверки не запущены: ${state.error}.`, 1);
  const place = placeProblem(ctx, task, state);
  if (place) throw new UsageError(`Проверки не запущены: ${place}.`, 1);
  if (state.dirty.length > 0) {
    const shown = state.dirty.slice(0, 5).map((f) => `\n  ${f}`).join('');
    const more = state.dirty.length > 5 ? `\n  …и ещё ${state.dirty.length - 5}` : '';
    throw new UsageError(
      `Проверки не запущены: в рабочей копии незакоммиченные изменения (${state.dirty.length}):${shown}${more}\n` +
        `Проверки подтверждают коммит. Закоммитьте изменения (лишнее — в .gitignore) и повторите: kaiten verify ${ref}`,
      1,
    );
  }
  const names = gates.checks.map((c) => c.name);
  if (evidenceCovers(task.fm.checks, state.head, names)) {
    say(`Проверки проекта на коммите ${shortCommit(state.head)} уже пройдены. Сдавайте работу: kaiten review ${ref}`);
    return;
  }

  say(`Проверки проекта на коммите ${shortCommit(state.head)}: ${names.join(', ')}.`);
  const results: CheckResult[] = [];
  let failed: { check: ReviewCheck; run: CheckRun } | null = null;
  for (const check of gates.checks) {
    if (failed) {
      results.push({ name: check.name, outcome: 'skipped', ms: 0 });
      continue;
    }
    const run = await runCheck(check, state.root);
    results.push({ name: check.name, outcome: run.ok ? 'passed' : 'failed', ms: run.ms, ...(run.timedOut ? { timedOutMin: check.timeoutMin } : {}) });
    say(`  ${check.name} — ${run.ok ? 'прошла' : run.timedOut ? `не прошла: дольше ${check.timeoutMin} мин` : 'не прошла'} (${formatDuration(run.ms)})`);
    if (!run.ok) failed = { check, run };
  }

  // Свидетельство — о коммите: если за время прогона он сменился или проверки тронули файлы, проверено было другое.
  const after = workState(ctx.workDir);
  if (!failed && (('error' in after) || after.head !== state.head || after.dirty.length > 0)) {
    const changed = 'error' in after ? [] : after.dirty;
    throw new UsageError(
      `Прогон не засчитан: за время проверок рабочая копия изменилась${changed.length > 0 ? ` (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''})` : ''}. ` +
        `Проверки не должны менять файлы репозитория: закоммитьте изменения (или добавьте их в .gitignore) и повторите: kaiten verify ${ref}`,
      1,
    );
  }

  await commit(ctx, { kind: 'verify', id: task.fm.id, commit: state.head, results }, `проверки ${ref}`);
  if (!failed) {
    say(`Сдавайте работу: kaiten review ${ref}. Новый коммит после прогона — и проверки нужно повторить.`);
    return;
  }
  const tail = outputTail(failed.run.output);
  throw new UsageError(
    `Проверка ${failed.check.name} не прошла. Конец её вывода:\n\n${tail ? tail.split('\n').map((l) => `  ${l}`).join('\n') : '  (вывода нет)'}\n\n` +
      `Итог записан в журнал задачи ${ref}. Исправьте, закоммитьте и запустите снова: kaiten verify ${ref}`,
    1,
  );
}

async function verify(args: string[]): Promise<void> {
  const { positionals } = parse('verify', args, {}, 1);
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten verify PRJ-123');
  const ctx = resolveContext();
  printNotices(ctx);
  await verifyTask(ctx, positionals[0]);
}

export const VERIFY_COMMANDS: Record<string, (args: string[]) => Promise<void>> = { verify };
