/**
 * Исследование находки (`core/found.ts`): снимок основной ветки и задач во
 * временной папке → модель только на чтение → проверка ответа по снимку.
 * Общее для фоновой проверки `kaiten found` и скрипта владельца `npm run found`.
 *
 * СНИМОК, А НЕ РАБОЧАЯ ПАПКА. Агент, оставивший заметку, сидит на ветке своей
 * задачи с недоделанными правками: дефект, которого нет в основной ветке, —
 * его текущая работа, а не находка. Поэтому код берётся из последнего коммита
 * основной ветки (с сервера, если она там есть) и выкладывается отдельно, не
 * трогая ни рабочую папку, ни индекс, ни список рабочих копий репозитория.
 * Рядом кладутся задачи проекта и прежние находки — искать повторы и то, как
 * должно быть.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { runClaude, type ClaudeOutcome } from './claude-agent.js';
import {
  FINDINGS_DIR,
  FindingAnswerSchema,
  findingPrompt,
  SNAPSHOT_CODE,
  SNAPSHOT_TASKS,
  verifyFinding,
  type Finding,
  type FindingVerdict,
  type SnapshotHead,
} from './core/found.js';
import { resolveTask, type TaskRecord } from './core/tasks-index.js';

/** Одно исследование дольше — что-то пошло не так: заметка остаётся неисследованной. */
export const INVESTIGATION_TIMEOUT_MS = 20 * 60_000;

function gitOut(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout?: number): string | null {
  try {
    return execFileSync('git', args, { cwd, env: env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28, windowsHide: true, timeout }).trim();
  } catch {
    return null;
  }
}

export interface Snapshot {
  root: string;
  head: SnapshotHead;
  remove: () => void;
}

export interface SnapshotInput {
  /** Любая папка рабочей копии репозитория кода. */
  codeDir: string;
  /** Основная ветка репозитория (`repos[].branch`). */
  branch: string;
  /** Файлы репозитория задач: задачи, журналы, прежние находки — путь от его корня. */
  files: ReadonlyArray<{ path: string; text: string }>;
}

/** Снимок для исследователя; ошибка — словами, чего не хватило. */
export function makeSnapshot(input: SnapshotInput): Snapshot | { error: string } {
  const top = gitOut(input.codeDir, ['rev-parse', '--show-toplevel']);
  if (top === null) return { error: 'папка кода — не рабочая копия git' };
  // Свежая основная ветка — меньше находок, которые уже исправлены. Нет сети — берём, что есть.
  gitOut(top, ['fetch', '--quiet', 'origin', input.branch], undefined, 60_000);
  const commit = gitOut(top, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${input.branch}^{commit}`]) ?? gitOut(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}^{commit}`]);
  if (!commit) return { error: `в репозитории кода нет ветки ${input.branch}` };

  const root = mkdtempSync(join(tmpdir(), 'kaiten-found-'));
  const remove = (): void => rmSync(root, { recursive: true, force: true });
  // Свой индекс: ни индекс, ни рабочая папка репозитория не меняются.
  const env = { ...process.env, GIT_INDEX_FILE: join(root, '.index') };
  const prefix = `${join(root, SNAPSHOT_CODE).replace(/\\/g, '/')}/`;
  if (gitOut(top, ['read-tree', commit], env) === null || gitOut(top, ['checkout-index', '--all', '--force', `--prefix=${prefix}`], env) === null) {
    remove();
    return { error: 'не удалось выложить код основной ветки' };
  }
  rmSync(join(root, '.index'), { force: true });
  for (const file of input.files) {
    const target = join(root, file.path.startsWith(`${FINDINGS_DIR}/`) ? file.path : `${SNAPSHOT_TASKS}/${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text, 'utf8');
  }
  return { root, head: { branch: input.branch, commit }, remove };
}

/** Файл снимка по пути от его корня; за пределы снимка не выходит. */
function snapshotReader(root: string): (path: string) => string | null {
  const base = resolve(root);
  return (path) => {
    const full = resolve(base, path);
    if (!full.startsWith(base + sep) || !existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full, 'utf8');
  };
}

export type Investigator = (job: { cwd: string; prompt: string; model: string }) => Promise<ClaudeOutcome>;

/** Модель только на чтение: ни записи, ни команд, ни MCP. */
export const claudeInvestigator: Investigator = ({ cwd, prompt, model }) =>
  runClaude({ model, cwd, prompt, schema: FindingAnswerSchema, tools: ['Read', 'Grep', 'Glob'], allowed: ['Read', 'Grep', 'Glob'], timeoutMs: INVESTIGATION_TIMEOUT_MS });

export interface InvestigateInput {
  finding: Finding;
  tasks: readonly TaskRecord[];
  snapshot: SnapshotInput;
  model: string;
  run?: Investigator;
}

/**
 * Исследовать одну находку. `error` — исследование не состоялось (нет ветки,
 * модель не запустилась или ответила не по схеме): вердикта нет, заметка
 * остаётся неисследованной. Вердикт «не подтверждена» — это уже ответ.
 */
export async function investigate(input: InvestigateInput): Promise<{ verdict: FindingVerdict; head: SnapshotHead; costUsd: number } | { error: string }> {
  const snapshot = makeSnapshot(input.snapshot);
  if ('error' in snapshot) return snapshot;
  try {
    const from = input.finding.fm.from ? (input.tasks.find((t) => t.slug === input.finding.fm.from) ?? null) : null;
    const outcome = await (input.run ?? claudeInvestigator)({ cwd: snapshot.root, prompt: findingPrompt({ finding: input.finding, head: snapshot.head, from }), model: input.model });
    if ('error' in outcome) return { error: outcome.error };
    const answer = FindingAnswerSchema.safeParse(outcome.answer);
    if (!answer.success) return { error: `ответ не по схеме: ${answer.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    const verdict = verifyFinding(
      input.finding,
      answer.data,
      {
        readFile: snapshotReader(snapshot.root),
        findTask: (ref) => {
          const found = resolveTask(input.tasks, ref);
          return 'error' in found ? null : found.task;
        },
      },
      snapshot.head,
    );
    return { verdict, head: snapshot.head, costUsd: outcome.costUsd ?? 0 };
  } finally {
    snapshot.remove();
  }
}
