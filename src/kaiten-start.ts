/**
 * `kaiten start <задача>` — ветка задачи в текущем репозитории кода (этап 3).
 *
 * Правила и имя ветки — `core/start.ts`. Команда только заводит ветку (или
 * переключает на уже заведённую для этой карточки) — в задачи и в Kaiten она
 * не пишет: карточку двигает интеграция Kaiten ↔ GitHub, когда ветку
 * отправят на GitHub. Отправку делает человек или агент обычным `git push`:
 * код — не забота kaiten.
 *
 * Git здесь — репозиторий кода, из которого запущена команда, а не хранилище
 * задач, поэтому первая строка ошибки git показывается как есть: она про код
 * человека (например, «ваши изменения будут перезаписаны»).
 */

import { spawnSync } from 'node:child_process';

import { branchName, cardNumber, startProblem } from './core/start.js';
import { refOf } from './core/tasks-index.js';
import { findTask, loadTasks, parse, printNotices, resolveContext, TASK_REF_HELP, UsageError } from './kaiten-cli.js';

export const START_HELP = `kaiten start <задача> — взять задачу в работу: ветка задачи в этом репозитории.

Заводит ветку feature/<номер карточки>-<имя задачи> от текущей и
переключается на неё; если ветка задачи уже есть — просто переключается.
Когда ветка появится на GitHub (git push), карточка перейдёт в «В работе»,
PR — в «Ревью», слияние — в «Сделано». В сообщениях коммитов указывайте
#<номер карточки> — коммит появится в карточке.

В работу берут задачу из «Готово к работе» или «Заблокировано»; задачу в
работе или на ревью — продолжают.
${TASK_REF_HELP}

Пример:
  kaiten start PRJ-123
  git push -u origin HEAD
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

/**
 * Завести ветку задачи или переключиться на уже заведённую для этой
 * карточки — в том числе под старым именем (заголовок задачи с тех пор
 * поменяли). Ошибка — словами для человека.
 */
export function switchToTaskBranch(workDir: string, cardId: string, wanted: string): BranchResult | { error: string } {
  if (!git(workDir, ['rev-parse', '--is-inside-work-tree']).ok) return { error: 'эта папка — не репозиторий git' };
  const existing = git(workDir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/feature/${cardId}`, `refs/heads/feature/${cardId}-*`])
    .out.split('\n')
    .filter(Boolean);
  const current = git(workDir, ['branch', '--show-current']).out || null;
  const branch = current !== null && existing.includes(current) ? current : existing.includes(wanted) ? wanted : (existing[0] ?? wanted);
  if (current === branch) return { branch, how: 'already', from: null };
  const created = existing.length === 0;
  const r = git(workDir, created ? ['switch', '-c', branch] : ['switch', branch]);
  if (!r.ok) return { error: `git не переключил ветку: ${r.err.split('\n')[0] || 'без объяснений'}` };
  return { branch, how: created ? 'created' : 'switched', from: created ? current : null };
}

async function start(args: string[]): Promise<void> {
  const { positionals } = parse('start', args, {}, 1);
  if (positionals.length === 0) throw new UsageError('Укажите задачу: kaiten start PRJ-123');
  const ctx = resolveContext();
  printNotices(ctx);
  const task = findTask(loadTasks(ctx).index, positionals[0]);
  const problem = startProblem(task, ctx.currentRepo);
  if (problem) throw new UsageError(`Задачу ${refOf(task)} не взять в работу: ${problem}.`, 1);
  const cardId = cardNumber(task) ?? '';
  const result = switchToTaskBranch(ctx.workDir, cardId, branchName(cardId, task.slug));
  if ('error' in result) throw new UsageError(`Задачу ${refOf(task)} не взять в работу: ${result.error}.`, 1);

  if (result.how === 'created') console.log(`Ветка ${result.branch} — новая${result.from ? `, от ${result.from}` : ''}.`);
  else if (result.how === 'switched') console.log(`Ветка ${result.branch} — у задачи уже была, переключился на неё.`);
  else console.log(`Вы уже на ветке задачи ${result.branch}.`);
  console.log(`Карточка перейдёт в «В работе», когда ветка появится на GitHub: git push -u origin ${result.branch}`);
  console.log(`В сообщениях коммитов указывайте #${cardId}, например: feat(#${cardId}): что сделано`);
}

export const START_COMMANDS: Record<string, (args: string[]) => Promise<void>> = { start };
