/**
 * `kaiten start <задача>` — взять задачу в работу: ветка задачи в текущем
 * репозитории кода и статус «В работе» (этап 3).
 *
 * Правила и имя ветки — `core/start.ts`. Порядок: проверки → ветка → карточка
 * (при `sync.kaiten`, отказ доски останавливает запись) → файл. Ветка — первой:
 * её ошибка (например, незакоммиченные правки мешают переключиться) не
 * должна оставить задачу «в работе» без ветки. Ветку на GitHub отправляет
 * человек или агент обычным `git push`: код — не забота kaiten.
 *
 * Git здесь — репозиторий кода, из которого запущена команда, а не хранилище
 * задач, поэтому первая строка ошибки git показывается как есть: она про код
 * человека.
 */

import { spawnSync } from 'node:child_process';

import { branchName, startProblem } from './core/start.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { cardNotMovedNote, findTask, loadTasks, moveCardFirst, parse, printNotices, resolveContext, TASK_REF_HELP, UsageError } from './kaiten-cli.js';
import { commit } from './kaiten-write.js';

export const START_HELP = `kaiten start <задача> — взять задачу в работу.

Ставит задаче «В работе» и заводит ветку feature/<ключ>-<имя задачи> от
текущей; если ветка задачи уже есть — переключается на неё. Дальше:
kaiten review — работа готова, kaiten done — влито в прод.

В работу берут задачу из «Готово к работе», «Заблокировано» или «Ревью»
(вернули на доработку); задачу в работе — продолжают. Задачу из «Бэклога»
берут, только если человек прямо поручил именно её.
${TASK_REF_HELP}

Флаги:
  --assigned          человек прямо поручил эту задачу: взять её и из «Бэклога»

Примеры:
  kaiten start PRJ-123
  kaiten start PRJ-140 --assigned
`;

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export interface BranchResult {
  branch: string;
  /** Новая ветка / переключились на заведённую раньше / уже на ней. */
  how: 'created' | 'switched' | 'already';
  /** От какой ветки заведена новая. */
  from: string | null;
}

/** Ветки, которые уже могли быть заведены для задачи: по ключу (в том числе под старым именем) и по slug. */
function taskBranchRefs(task: TaskRecord): string[] {
  const refs = [`refs/heads/feature/${task.slug}`];
  if (task.fm.tracker !== undefined) refs.unshift(`refs/heads/feature/${task.fm.tracker}`, `refs/heads/feature/${task.fm.tracker}-*`);
  return refs;
}

/**
 * Завести ветку задачи или переключиться на уже заведённую — в том числе под
 * старым именем (заголовок задачи сменили, ключ появился позже). Ошибка —
 * словами для человека.
 */
export function switchToTaskBranch(workDir: string, task: TaskRecord): BranchResult | { error: string } {
  if (!git(workDir, ['rev-parse', '--is-inside-work-tree']).ok) return { error: 'эта папка — не репозиторий git' };
  const wanted = branchName(task);
  const existing = git(workDir, ['for-each-ref', '--format=%(refname:short)', ...taskBranchRefs(task)]).out.split('\n').filter(Boolean);
  const current = git(workDir, ['branch', '--show-current']).out || null;
  const branch = current !== null && existing.includes(current) ? current : existing.includes(wanted) ? wanted : (existing[0] ?? wanted);
  if (current === branch) return { branch, how: 'already', from: null };
  const created = existing.length === 0;
  const r = git(workDir, created ? ['switch', '-c', branch] : ['switch', branch]);
  if (!r.ok) return { error: `git не переключил ветку: ${r.err.split('\n')[0] || 'без объяснений'}` };
  return { branch, how: created ? 'created' : 'switched', from: created ? current : null };
}

async function start(args: string[]): Promise<void> {
  const { values, positionals } = parse('start', args, { assigned: { type: 'boolean' } }, 1);
  const assigned = values.assigned === true;
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten start PRJ-123');
  const ctx = resolveContext();
  printNotices(ctx);
  const task = findTask(loadTasks(ctx).index, positionals[0]);
  const problem = startProblem(task, ctx.currentRepo, assigned);
  if (problem) throw new UsageError(`Задачу ${refOf(task)} не взять в работу: ${problem}.`, 1);
  const result = switchToTaskBranch(ctx.workDir, task);
  if ('error' in result) throw new UsageError(`Задачу ${refOf(task)} не взять в работу: ${result.error}.`, 1);

  if (result.how === 'created') console.log(`Ветка ${result.branch} — новая${result.from ? `, от ${result.from}` : ''}; вы на ней.`);
  else if (result.how === 'switched') console.log(`Ветка ${result.branch} — у задачи уже была, переключился на неё.`);
  else console.log(`Вы уже на ветке задачи ${result.branch}.`);

  if (task.fm.status === 'in-progress') {
    console.log(`Задача ${refOf(task)} уже в работе${result.how === 'created' ? ' — в этом репозитории её ветки ещё не было' : ''}.`);
    return;
  }
  let card: Awaited<ReturnType<typeof moveCardFirst>>;
  try {
    // Доска пускает «В работу» только из «Готово к работе»: задачу из «Бэклога» карточка проходит в два шага.
    if (task.fm.status === 'backlog') await moveCardFirst(ctx, task, 'ready');
    card = await moveCardFirst(ctx, task, 'in-progress');
  } catch (error) {
    // Ветка уже заведена — так и сказать, иначе человек решит, что не сделано ничего.
    if (error instanceof UsageError) throw new UsageError(`${error.message}\nВетка ${result.branch} заведена, задача осталась в прежнем статусе.`, error.code);
    throw error;
  }
  await commit(ctx, { kind: 'move', id: task.fm.id, status: 'in-progress', ...(assigned ? { assigned: true } : {}) }, `в работу ${refOf(task)}`);
  cardNotMovedNote(card);
}

export const START_COMMANDS: Record<string, (args: string[]) => Promise<void>> = { start };
