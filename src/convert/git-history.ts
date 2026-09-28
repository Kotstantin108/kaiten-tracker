/**
 * История задач из git для конвертера: кто завёл задачу, когда её в
 * последний раз меняли, кто и когда закрыл. Считается один раз при переносе,
 * пока история лежит рядом (story `export-csv`): в репозитории задач v2
 * она начинается с одного импортного коммита.
 *
 * Один проход `git log --name-status` на репозиторий, а не вызов на файл:
 * шестьсот вызовов git на Windows — минуты. Задача узнаётся по ключу, который
 * переживает переезды между папками-статусами и смену приоритета в имени:
 * `<дата>_<slug>` для папок, имя файла для нумерованной школы globex.
 */

import { execFileSync } from 'node:child_process';

export interface CommitInfo {
  author: string;
  /** Почта автора: по ней, а не по имени, автор сопоставляется с человеком. */
  email: string;
  /** Дата автора, `YYYY-MM-DD`. */
  date: string;
}

export interface TaskHistory {
  first: CommitInfo;
  last: CommitInfo;
  /** Последний переезд в закрытую папку (`done/`, `cancelled/`); `null` — не найден. */
  closed: CommitInfo | null;
}

interface FileChange {
  status: string;
  paths: string[];
}

interface RawCommit extends CommitInfo {
  changes: FileChange[];
}

const RECORD = '\x1e';
const FIELD = '\x1f';

/** Разбор вывода `git log --format=<RECORD>%an<FIELD>%ae<FIELD>%aI<FIELD>%B<FIELD> --name-status`. */
export function parseGitLog(output: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const chunk of output.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [author, email, isoDate, , rest = ''] = chunk.split(FIELD);
    const changes: FileChange[] = [];
    for (const line of rest.split('\n')) {
      const parts = line.replace(/\r$/, '').split('\t');
      if (parts.length < 2 || !/^[ACDMRT]\d*$/.test(parts[0])) continue;
      changes.push({ status: parts[0][0], paths: parts.slice(1) });
    }
    commits.push({ author: author.trim(), email: (email ?? '').trim().toLowerCase(), date: (isoDate ?? '').trim().slice(0, 10), changes });
  }
  return commits;
}

const FOLDER_KEY_RE = /^(\d{8})_[a-z]+_[^_/]+_(.+)$/;
const NUMBERED_RE = /^\d{4}-[a-z0-9-]+\.md$/;

/**
 * Ключ задачи по пути файла и признак «лежит в закрытой папке». Для папок —
 * самая глубокая папка-задача в пути (подзадача внутри эпика — своя задача).
 */
export function keyOfPath(path: string, layout: 'folders' | 'numbered'): { key: string; closed: boolean } | null {
  const parts = path.split('/');
  if (parts[0] !== 'tasks') return null;
  if (layout === 'numbered') {
    const file = parts.at(-1) ?? '';
    if (!NUMBERED_RE.test(file)) return null;
    return { key: file.replace(/\.md$/, ''), closed: parts[1] === 'done' };
  }
  let key: string | null = null;
  for (const segment of parts.slice(1, -1)) {
    const m = FOLDER_KEY_RE.exec(segment);
    if (m) key = `${m[1]}_${m[2]}`;
  }
  if (!key) return null;
  return { key, closed: parts[1] === 'done' || parts[1] === 'cancelled' };
}

/**
 * История по ключам. Коммиты идут от старых к новым; задача считается
 * закрытой коммитом, который впервые положил её файл в закрытую папку после
 * открытой (или создал сразу там).
 */
export function buildHistory(commitsNewestFirst: RawCommit[], layout: 'folders' | 'numbered'): Map<string, TaskHistory> {
  const result = new Map<string, TaskHistory>();
  const location = new Map<string, boolean>();
  for (const commit of [...commitsNewestFirst].reverse()) {
    const info: CommitInfo = { author: commit.author, email: commit.email, date: commit.date };
    const touched = new Map<string, { closedNow: boolean; wasOpen: boolean }>();
    for (const change of commit.changes) {
      const target = keyOfPath(change.paths.at(-1) ?? '', layout);
      const source = change.paths.length > 1 ? keyOfPath(change.paths[0], layout) : null;
      if (target && change.status !== 'D') {
        const prev = touched.get(target.key);
        const wasOpen = source ? !source.closed : location.get(target.key) === false;
        touched.set(target.key, { closedNow: target.closed || (prev?.closedNow ?? false), wasOpen: wasOpen || (prev?.wasOpen ?? false) });
      }
    }
    for (const [key, t] of touched) {
      const known = result.get(key);
      const becameClosed = t.closedNow && (!known || t.wasOpen || location.get(key) === false);
      result.set(key, {
        first: known?.first ?? info,
        last: info,
        closed: becameClosed ? info : (known?.closed ?? null),
      });
      location.set(key, t.closedNow);
    }
  }
  return result;
}

/**
 * Прочитать историю `tasks/` репозитория. Только чтение.
 *
 * Второй проход — по главной линии с диффами слияний: файл, появившийся
 * прямо в коммите слияния (так завели globex `0051`), обычный `git log` не
 * показывает. Из второго прохода берутся только задачи, которых нет в первом.
 */
export function readHistory(repoPath: string, layout: 'folders' | 'numbered', tasksDirName = 'tasks'): Map<string, TaskHistory> {
  const run = (extra: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'log', '-M', ...extra, '--name-status', `--format=${RECORD}%an${FIELD}%ae${FIELD}%aI${FIELD}%B${FIELD}`, '--', tasksDirName],
      { cwd: repoPath, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  const history = buildHistory(parseGitLog(run([])), layout);
  for (const [key, value] of buildHistory(parseGitLog(run(['-m', '--first-parent'])), layout)) {
    if (!history.has(key)) history.set(key, value);
  }
  return history;
}
