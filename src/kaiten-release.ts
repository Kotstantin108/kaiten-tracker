/**
 * `kaiten release` — записать выкатку в прод в журнал выкаток проекта
 * (`docs/releases.md`, чистая часть — `core/release.ts`).
 *
 * Журнал — страница Kaiten с одной таблицей; её читает дашборд. Команда
 * запускается после пуша в ветку прода: каркас записи (поверхность, версия,
 * время, коммит, задачи выкатки) собирает сама, агент даёт только строки
 * «задача | зона | тип | что изменилось». Без `--apply` ничего не пишется.
 *
 * Порядок записи: проверки → тег `released/<версия>` с копией записи и его
 * отправка в origin → страница. Тег — первым: страница без тега не
 * восстановилась бы, а тег без страницы дописывает `--rebuild`.
 *
 * Сверка. Выкатка, сделанная в обход команды, не должна потеряться:
 * `kaiten start` и `kaiten doctor` сравнивают ветку прода с записями и
 * отказывают, пока выкатка не записана (`releaseGateProblem`).
 *
 * Git здесь — репозиторий кода, из которого запущена команда, поэтому первая
 * строка ошибки git показывается как есть: она про код человека.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { docOf, parseDocData } from './agent-server/prosemirror.js';
import { releaseSetting, type ProjectConfig, type ReleaseSetting, type RepoRelease } from './config.js';
import {
  calendarVersion,
  chooseTime,
  COLUMNS,
  journalStart,
  mergedBranch,
  mergeRows,
  overdue,
  pageNodes,
  parseChangelog,
  parseChanges,
  parseRecordMessage,
  readPage,
  RECORD_TAG_PREFIX,
  recordKey,
  recordMessage,
  recordTagName,
  releaseTime,
  rowsOf,
  timeOf,
  titleProblem,
  uncoveredTasks,
  versionProblem,
  type ChangelogEntry,
  type DeployFacts,
  type DeployPoint,
  type PageState,
  type RecordedTag,
  type ReleaseRecord,
  type ReleaseRow,
} from './core/release.js';
import { refOf, resolveTask, type TaskRecord } from './core/tasks-index.js';
import { loadTasks, parse, printNotices, resolveContext, settings, stringFlag, UsageError, type Context, type Values } from './kaiten-cli.js';
import { isOutage, KaitenApiError, KaitenClient, outageText } from './kaiten-client.js';

export const RELEASE_HELP = `kaiten release — записать выкатку в прод в журнал выкаток проекта.

Журнал — страница в Kaiten: что вышло в прод, когда и в какой части продукта.
По ней потом смотрят, какое изменение сдвинуло метрики, поэтому записывается
каждая выкатка и всегда в одном виде. Запускайте из репозитория, который
выкатили, сразу после того, как убедились, что прод обновился.

Без флагов команда показывает выкатку, которую пора записать, и задачи,
которые в неё вошли. Про каждое изменение — строка:

  <задача или -> | <зона> | <тип> | <раздел или -> | <что изменилось>

Зона и тип — только из словарей проекта (команда их покажет). Раздел —
заголовок, под которым правка стоит в списке изменений проекта; нет — «-».
Каждая задача выкатки должна быть хотя бы в одной строке; изменение без
задачи — с «-». Если проект ведёт список изменений, команда сама разложит
его пункты по строкам — останется вписать зону, тип и задачу.
Строки передают через --stdin. Без --apply ничего не пишется: сначала
посмотрите, что получится, потом повторите с --apply.

У выкатки есть название — коротко, что вышло. Команда берёт его из списка
изменений проекта; нет списка — назовите сами: --title.

Время записи — момент запуска команды. Выкатку, которая вышла раньше,
записывают с --missed: время возьмётся из её коммита и будет помечено как
приблизительное.

Флаги:
  --stdin             строки изменений — из стандартного ввода
  --apply             записать (без него — только показать)
  --title <текст>     название выкатки, если команда не нашла его сама
  --version <версия>  какую версию записать, если не записано несколько
  --commit <коммит>   какую выкатку записать — там, где версию выдаёт запись
  --missed            выкатка вышла раньше: время — из коммита, приблизительно
  --now               коммит давний, а в прод вышел только что
  --amend             исправить уже сделанную запись версии (--version):
                      новые строки и название заменяют прежние, время остаётся
  --rollback <версия> записать откат версии; нужен --reason
  --reason <текст>    почему откатили
  --rebuild           вернуть на страницу строки этого репозитория из его
                      записей — если страница повреждена или запись оборвалась

Примеры:
  kaiten release
  kaiten release --stdin <<'EOF'
  PRJ-123 | пейволл | изменение | Тарифы | Цена годового тарифа видна до оплаты
  - | скорость | техническое | - | Обновление зависимостей
  EOF
  kaiten release --rollback v1.4.0 --reason "Не проходит оплата картой" --apply
`;

type On = Extract<ReleaseSetting, { state: 'on' }>;

// ── git репозитория кода ─────────────────────────────────────────────────

interface GitRun {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string; env?: Record<string, string> } = {}): GitRun {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: opts.timeoutMs, input: opts.input, maxBuffer: 64 * 1024 * 1024, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const firstLine = (text: string): string => text.split('\n')[0] || 'без объяснений';

/** Сколько коммитов ветки прода просматриваем в поисках записанного. */
const CHAIN_LIMIT = 2000;
const FIELD = '\x1f';
const RECORD = '\x1e';

export interface RepoFacts extends DeployFacts {
  /** Ветка прода, как её знает репозиторий: `origin/production`. */
  prodRef: string;
  head: string;
  /** Удалось ли обновить ветку прода и записи с сервера. */
  fetched: boolean;
  /** Все выкатки, которые видно в репозитории, от старых к новым: теги версий или коммиты ветки прода. */
  points: DeployPoint[];
  /** Имена всех тегов записей — занятые имена. */
  tagNames: Set<string>;
}

export type FetchMode = 'required' | 'try' | 'no';

/**
 * Что видно в репозитории кода: ветка прода, записи и выкатки без записи.
 * Ошибка — словами для человека.
 */
export function readFacts(workDir: string, repo: RepoRelease, fetch: FetchMode, timeoutMs = 60_000): RepoFacts | { error: string } {
  if (!git(workDir, ['rev-parse', '--is-inside-work-tree']).ok) return { error: 'эта папка — не репозиторий git' };
  let fetched = false;
  if (fetch !== 'no') {
    const r = git(workDir, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${repo.branch}:refs/remotes/origin/${repo.branch}`, `+refs/tags/${RECORD_TAG_PREFIX}*:refs/tags/${RECORD_TAG_PREFIX}*`], { timeoutMs });
    fetched = r.ok;
    if (!r.ok && fetch === 'required') return { error: `ветку ${repo.branch} не удалось получить из origin: ${firstLine(r.err)}` };
    // Теги версий — как получится: свой тег человека с тем же именем перезаписывать нельзя.
    if (r.ok && repo.versions === 'tags') git(workDir, ['fetch', '--quiet', '--no-tags', 'origin', `refs/tags/${repo.tagPrefix}*:refs/tags/${repo.tagPrefix}*`], { timeoutMs });
  }
  const prodRef = `origin/${repo.branch}`;
  const head = git(workDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${prodRef}^{commit}`]);
  if (!head.ok || !head.out) return { error: `в репозитории нет ветки прода ${prodRef}` };

  const tags = git(workDir, ['for-each-ref', `--format=%(refname:short)%1f%(*objectname)%1f%(objectname)%1f%(taggerdate:iso-strict)%1f%(contents)%1e`, `refs/tags/${RECORD_TAG_PREFIX}`]);
  const tagNames = new Set<string>();
  const recorded: RecordedTag[] = [];
  for (const chunk of tags.out.split(RECORD)) {
    const [name, peeled, object, taggedAt, message] = chunk.replace(/^\n/, '').split(FIELD);
    if (!name) continue;
    tagNames.add(name);
    const record = parseRecordMessage(message ?? '');
    // Тег без записи внутри поставлен не командой: имя занято, но выкатку он не записывает.
    if (!record || !taggedAt) continue;
    recorded.push({ tag: name, commit: peeled || object, taggedAt: new Date(taggedAt), record });
  }

  const points = repo.versions === 'tags' ? versionPoints(workDir, repo, prodRef) : chainPoints(workDir, prodRef);
  const releases = recorded.filter((r) => r.record?.event === 'релиз');
  let pending: DeployPoint[];
  if (repo.versions === 'tags') {
    const done = new Set(releases.map((r) => r.record?.version));
    pending = points.filter((p) => !done.has(p.version));
  } else {
    const done = new Set(recorded.map((r) => r.commit));
    // Журнал не начат — записывать предлагаем только то, что в проде сейчас; история — по --commit.
    const after = recorded.length === 0 ? points.slice(-1) : points.slice(points.findLastIndex((p) => done.has(p.commit)) + 1);
    pending = after.filter((p) => !done.has(p.commit));
  }

  return { prodRef, head: head.out, fetched, points, tagNames, recorded, pending, rolledBack: rolledBack(workDir, prodRef, recorded) };
}

/** Теги версий, достижимые из ветки прода, по возрастанию версии. */
function versionPoints(workDir: string, repo: RepoRelease, prodRef: string): DeployPoint[] {
  const r = git(workDir, ['for-each-ref', '--merged', prodRef, '--sort=version:refname', `--format=%(refname:short)%1f%(*objectname)%1f%(objectname)%1f%(taggerdate:iso-strict)%1f%(committerdate:iso-strict)%1f%(contents:subject)%1e`, `refs/tags/${repo.tagPrefix}*`]);
  const points: DeployPoint[] = [];
  for (const chunk of r.out.split(RECORD)) {
    const [name, peeled, object, taggerDate, commitDate, subject] = chunk.replace(/^\n/, '').split(FIELD);
    // После начала тега версии — цифра: `v1.2.3`, но не `vendor-backup`.
    if (!name || !/^\d/.test(name.slice(repo.tagPrefix.length)) || versionProblem(name)) continue;
    const time = taggerDate || commitDate;
    if (!time) continue;
    points.push({ version: name, commit: peeled || object, time: new Date(time), subject });
  }
  return points;
}

/** Коммиты ветки прода по первому родителю, от старых к новым: каждый — отдельная выкатка. */
function chainPoints(workDir: string, prodRef: string): DeployPoint[] {
  const r = git(workDir, ['log', '--first-parent', `--max-count=${CHAIN_LIMIT}`, `--format=%H${'%x1f'}%cI${'%x1f'}%s`, prodRef]);
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, time, subject] = line.split(FIELD);
      return { commit, time: new Date(time), subject };
    })
    .reverse();
}

/** Последний записанный релиз не достижим из ветки прода, и записи об откате после него нет. */
function rolledBack(workDir: string, prodRef: string, recorded: readonly RecordedTag[]): { version: string } | null {
  const releases = recorded.filter((r) => r.record?.event === 'релиз').sort((a, b) => b.taggedAt.getTime() - a.taggedAt.getTime());
  const last = releases[0];
  if (!last?.record) return null;
  if (git(workDir, ['merge-base', '--is-ancestor', last.commit, prodRef]).ok) return null;
  const noted = recorded.some((r) => r.record?.event === 'откат' && r.record.version === last.record?.version && r.taggedAt.getTime() >= last.taggedAt.getTime());
  return noted ? null : { version: last.record.version };
}

// ── задачи выкатки ───────────────────────────────────────────────────────

/** Задача по имени влитой ветки: по ветке, записанной в задаче, по ключу карточки в имени, по имени задачи. */
export function taskOfBranch(tasks: readonly TaskRecord[], branch: string): TaskRecord | null {
  const byBranch = tasks.find((t) => t.fm.branch === branch);
  if (byBranch) return byBranch;
  const tail = branch.split('/').at(-1) ?? branch;
  const key = /^(\d+)(?:-|$)/.exec(tail)?.[1];
  if (key) {
    const byKey = tasks.find((t) => t.fm.tracker === key);
    if (byKey) return byKey;
  }
  return tasks.find((t) => t.slug === tail) ?? null;
}

interface Detected {
  tasks: TaskRecord[];
  /** Влитые ветки, по которым задача не нашлась. */
  unknown: string[];
}

function detectTasks(workDir: string, tasks: readonly TaskRecord[], from: string | null, to: string, skip: ReadonlySet<string>): Detected {
  if (!from) return { tasks: [], unknown: [] };
  const r = git(workDir, ['log', '--merges', '--format=%s', `${from}..${to}`]);
  const found = new Map<string, TaskRecord>();
  const unknown = new Set<string>();
  for (const subject of r.out.split('\n')) {
    const branch = mergedBranch(subject);
    if (!branch || skip.has(branch)) continue;
    const task = taskOfBranch(tasks, branch);
    if (task) found.set(task.fm.id, task);
    else unknown.add(branch);
  }
  return { tasks: [...found.values()], unknown: [...unknown] };
}

// ── страница ─────────────────────────────────────────────────────────────

export interface ReleaseDeps {
  /** Подменяется в тестах. */
  client?: KaitenClient;
  now?: Date;
  /** Строки изменений вместо стандартного ввода. */
  input?: string;
  say?: (line: string) => void;
}

function pageError(error: unknown): UsageError {
  if (error instanceof KaitenApiError) {
    const status = error.status;
    if (isOutage(error)) return new UsageError(`Не записано: ${outageText(error)}. Повторите команду позже — выкатка останется незаписанной, пока её не запишут.`, 1);
    if (status === 404) return new UsageError('Не записано: страница журнала выкаток в Kaiten не найдена. Это вопрос к владельцу проекта.', 1);
    if (status === 401 || status === 403) return new UsageError('Не записано: у вас нет доступа к странице журнала выкаток в Kaiten. Это вопрос к владельцу проекта.', 1);
    return new UsageError(`Не записано: Kaiten не принял запрос к странице журнала (${status}).`, 1);
  }
  return error instanceof UsageError ? error : new UsageError('Не записано: страница журнала выкаток не прочитана.', 1);
}

async function loadPage(client: KaitenClient, page: string): Promise<PageState> {
  try {
    return readPage(parseDocData((await client.getDocument(page)).data));
  } catch (error) {
    throw pageError(error);
  }
}

/** Записать строки на страницу и убедиться, что они там. */
async function writePage(client: KaitenClient, page: string, rows: readonly ReleaseRow[], mustHave: readonly ReleaseRow[]): Promise<void> {
  try {
    await client.updateDocument(page, { data: docOf(pageNodes(rows)) });
  } catch (error) {
    throw pageError(error);
  }
  const after = await loadPage(client, page);
  const present = new Set((after.state === 'ok' ? after.rows : []).map((r) => JSON.stringify(r)));
  if (after.state !== 'ok' || mustHave.some((r) => !present.has(JSON.stringify(r)))) {
    throw new UsageError('Страница журнала после записи читается не так, как записана: её могли держать открытой в редакторе. Закройте её в Kaiten и восстановите: kaiten release --rebuild --apply', 1);
  }
}

const BROKEN_FIX = 'Закройте страницу в редакторе Kaiten и восстановите её: kaiten release --rebuild (покажет, что получится), затем с --apply.';

/** Клиент Kaiten для записи; `null` — входа нет или обновление Kaiten выключено. */
function kaitenClient(deps: ReleaseDeps): { client: KaitenClient } | { missing: string } {
  if (deps.client) return { client: deps.client };
  const current = settings();
  if (!current.sync.kaiten) return { missing: 'обновление Kaiten выключено в настройках kaiten' };
  if (!current.kaiten) return { missing: 'в настройках kaiten нет входа в Kaiten (kaiten.domain и kaiten.token)' };
  return { client: new KaitenClient({ domain: current.kaiten.domain, token: current.kaiten.token, maxRetries: 2 }) };
}

function formatRows(rows: readonly ReleaseRow[]): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(COLUMNS), ...rows.map((r) => line([r.at, r.surface, r.version, r.title, r.event, r.zone, r.section, r.type, r.task, r.text]))];
}

// ── запись тега ──────────────────────────────────────────────────────────

/**
 * Тег записи — в репозиторий и в origin. `replace` — правка сделанной записи:
 * тег с тем же именем ставится заново и заменяет прежний на сервере, а дата
 * записи остаётся прежней — по ней считается начало журнала.
 */
function pushRecordTag(workDir: string, name: string, commit: string, record: ReleaseRecord, replace?: RecordedTag): void {
  const env = replace ? { GIT_COMMITTER_DATE: replace.taggedAt.toISOString() } : undefined;
  const created = git(workDir, ['tag', ...(replace ? ['-f'] : []), '-a', name, commit, '-F', '-'], { input: recordMessage(record), env });
  if (!created.ok) throw new UsageError(`Не записано: тег ${name} не создан — ${firstLine(created.err)}.`, 1);
  const pushed = git(workDir, ['push', '--quiet', ...(replace ? ['--force'] : []), 'origin', `refs/tags/${name}`], { timeoutMs: 120_000 });
  if (!pushed.ok) {
    // Прежний тег вернётся с сервера при следующем обновлении; новый, не отправленный, — убрать.
    git(workDir, ['tag', '-d', name]);
    throw new UsageError(`Не записано: тег ${name} не отправлен в origin — ${firstLine(pushed.err)}.`, 1);
  }
}

// ── команда ──────────────────────────────────────────────────────────────

function settingOrRefuse(project: ProjectConfig, repoName: string): On {
  const setting = releaseSetting(project, repoName);
  if (setting.state === 'off') throw new UsageError('В этом проекте журнал выкаток не ведётся. Записывать нечего.');
  if (setting.state === 'other-repo') {
    throw new UsageError(`Выкатки репозитория ${repoName} в журнал не попадают.${setting.surfaces.length > 0 ? ` Журнал ведут: ${setting.surfaces.join('; ')}.` : ''}`);
  }
  return setting;
}

const short = (commit: string): string => commit.slice(0, 7);

function describePoint(p: DeployPoint): string {
  return `${p.version ?? short(p.commit)} — ${releaseTime(p.time)}${p.subject && !p.version ? `, ${p.subject}` : ''}`;
}

function listPoints(points: readonly DeployPoint[], limit = 10): string {
  const shown = points.slice(-limit).map((p) => `\n  ${describePoint(p)}`);
  return `${points.length > limit ? `\n  …и ещё ${points.length - limit} раньше` : ''}${shown.join('')}`;
}

interface Chosen {
  point: DeployPoint;
  /** С какого места считать изменения: прошлая версия или прошлая записанная выкатка. */
  from: string | null;
  fromLabel: string | null;
  /** Сколько выкаток эта запись закрывает разом (там, где выкатка — коммит). */
  folded: number;
  /** Флаг, которым эту выкатку назвать в повторном запуске. */
  pick: string;
  /** Правка сделанной записи: её тег. */
  amend?: RecordedTag;
}

/** Запись версии, которую правят: коммит и время — из неё, изменения считаются заново. */
function chooseAmended(setting: On, facts: RepoFacts, values: Values): Chosen {
  const version = stringFlag(values, 'version');
  if (!version || values.commit || values.missed || values.now) throw new UsageError('Запись правят так: kaiten release --amend --version <версия> --stdin — время и коммит остаются прежними.');
  const amend = facts.recorded.find((r) => r.record?.event === 'релиз' && r.record.version === version && r.record.surface === setting.repo.surface);
  if (!amend?.record) throw new UsageError(`Версии ${version} нет среди записанных выкаток этого репозитория — править нечего.`, 1);
  const index = facts.points.findIndex((p) => p.commit === amend.commit);
  const recordedAt = new Set(facts.recorded.map((r) => r.commit));
  const earlier = index > 0 ? facts.points.slice(0, index) : [];
  const previous = setting.repo.versions === 'tags' ? earlier.at(-1) : (earlier.findLast((p) => recordedAt.has(p.commit)) ?? earlier.at(-1));
  const fromLabel = previous ? (previous.version ?? facts.recorded.find((r) => r.commit === previous.commit)?.record?.version ?? null) : null;
  return { point: { version, commit: amend.commit, time: amend.taggedAt }, from: previous?.commit ?? null, fromLabel, folded: 1, pick: ` --amend --version ${version}`, amend };
}

function choosePoint(setting: On, facts: RepoFacts, workDir: string, values: Values, say: (line: string) => void): Chosen | null {
  const version = stringFlag(values, 'version');
  const commit = stringFlag(values, 'commit');
  const start = journalStart(facts.recorded);
  const fresh = start ? facts.pending.filter((p) => p.time.getTime() > start.getTime()) : facts.pending;
  const history = facts.pending.length - fresh.length;

  if (setting.repo.versions === 'tags') {
    if (commit) throw new UsageError('--commit здесь не нужен: выкатка этого репозитория — тег версии. Укажите --version.');
    let point: DeployPoint | undefined;
    if (version) {
      point = facts.points.find((p) => p.version === version);
      if (!point) throw new UsageError(`Версии ${version} нет в ветке прода ${facts.prodRef}: тег версии должен стоять на коммите, который в неё вошёл.`, 1);
      if (!facts.pending.includes(point)) throw new UsageError(`Версия ${version} уже записана. Если её строк нет на странице журнала — kaiten release --rebuild.`, 1);
    } else if (fresh.length === 1) point = fresh[0];
    else if (fresh.length === 0) {
      say(facts.pending.length === 0 ? 'Все выкатки этого репозитория записаны.' : `Новых выкаток нет. В истории без записи: ${history} — записать одну: kaiten release --missed --version <версия>.${listPoints(facts.pending)}`);
      return null;
    } else throw new UsageError(`Не записано выкаток: ${fresh.length}. Укажите, какую записать, начиная со старшей: kaiten release --version <версия>.${listPoints(fresh)}`, 1);
    const index = facts.points.indexOf(point);
    const previous = index > 0 ? facts.points[index - 1] : null;
    return { point, from: previous?.commit ?? null, fromLabel: previous?.version ?? null, folded: 1, pick: ` --version ${point.version}` };
  }

  if (version) throw new UsageError('--version здесь не нужен: версию этого репозитория выдаёт запись. Выкатку называют коммитом: --commit <коммит>.');
  const recordedAt = new Map(facts.recorded.map((r) => [r.commit, r]));
  let index: number;
  if (commit) {
    const resolved = git(workDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    index = resolved.ok ? facts.points.findIndex((p) => p.commit === resolved.out) : -1;
    if (index < 0) throw new UsageError(`Коммита ${commit} нет среди выкаток ветки прода ${facts.prodRef}: выкатка — коммит самой ветки, а не влитой в неё.`, 1);
    const done = recordedAt.get(facts.points[index].commit);
    if (done) throw new UsageError(`Выкатка ${short(facts.points[index].commit)} уже записана как ${done.record?.version}. Если её строк нет на странице журнала — kaiten release --rebuild.`, 1);
  } else {
    if (facts.pending.length === 0) {
      say('Все выкатки этого репозитория записаны.');
      return null;
    }
    index = facts.points.length - 1;
  }
  const point = facts.points[index];
  const previous = facts.points.slice(0, index).findLast((p) => recordedAt.has(p.commit));
  const before = previous ?? (index > 0 ? facts.points[index - 1] : null);
  const folded = previous ? index - facts.points.indexOf(previous) : 1;
  const later = facts.points.slice(index + 1).find((p) => recordedAt.has(p.commit));
  if (later) say(`Позже этой выкатки уже записана ${recordedAt.get(later.commit)?.record?.version}: если та запись включала эти изменения, строки повторятся.\n`);
  return { point, from: before?.commit ?? null, fromLabel: previous ? (recordedAt.get(previous.commit)?.record?.version ?? null) : null, folded, pick: commit ? ` --commit ${short(point.commit)}` : '' };
}

function flagsText(values: Values): string {
  return `${values.missed ? ' --missed' : ''}${values.now ? ' --now' : ''}`;
}

/** Задачи проекта: по ним узнаются задачи выкатки и проверяются ключи в строках изменений. */
function tasksOf(ctx: Context): TaskRecord[] {
  return loadTasks(ctx).index.tasks;
}

export async function releaseCommand(ctx: Context, values: Values, deps: ReleaseDeps = {}): Promise<void> {
  const say = deps.say ?? console.log;
  const now = deps.now ?? new Date();
  const apply = values.apply === true;
  const setting = settingOrRefuse(ctx.loaded.project, ctx.currentRepo);
  const rollback = stringFlag(values, 'rollback');
  const reason = stringFlag(values, 'reason')?.trim();
  if (values.rebuild && (rollback || values.stdin || values.version || values.commit || values.missed || values.now)) throw new UsageError('--rebuild ставят один (и --apply): он возвращает на страницу уже сделанные записи.');
  if (rollback && (values.stdin || values.version || values.commit)) throw new UsageError('Откат записывают так: kaiten release --rollback <версия> --reason "<почему>".');
  if (reason !== undefined && !rollback) throw new UsageError('--reason — причина отката: он нужен только вместе с --rollback <версия>.');
  if (values.amend && (rollback || values.rebuild)) throw new UsageError('--amend правит запись релиза: kaiten release --amend --version <версия> --stdin.');

  const kaiten = kaitenClient(deps);
  if (apply && 'missing' in kaiten) throw new UsageError(`Не записано: ${kaiten.missing}. Журнал выкаток пишут с машины, где обновление Kaiten включено.`, 1);

  const facts = readFacts(ctx.workDir, setting.repo, apply ? 'required' : 'try');
  if ('error' in facts) throw new UsageError(`${apply ? 'Не записано' : 'Выкатку не посмотреть'}: ${facts.error}.`, 1);
  if (!facts.fetched) say(`Ветку прода не удалось обновить с сервера: показано то, что известно этому репозиторию.\n`);

  if (values.rebuild) return rebuild(setting, facts, kaiten, apply, ctx.loaded.project.ignoreCards, say);

  // Откат: одна строка, время и коммит — нынешнее состояние ветки прода.
  let record: ReleaseRecord;
  let pick = '';
  let amended: RecordedTag | undefined;
  if (rollback) {
    const target = facts.recorded.find((r) => r.record?.event === 'релиз' && r.record.version === rollback);
    if (!target) throw new UsageError(`Версии ${rollback} нет среди записанных выкаток этого репозитория — откат записывают для записанной версии.`, 1);
    if (!reason) throw new UsageError(`Скажите, почему откатили: kaiten release --rollback ${rollback} --reason "<почему>".`);
    const head = facts.points.find((p) => p.commit === facts.head) ?? { commit: facts.head, time: now };
    const time = values.missed ? chooseTime(head, now, { missed: true, now: false }) : { at: releaseTime(now), approx: false };
    if ('problem' in time) throw new UsageError(`Не записано: ${time.problem}.`, 1);
    record = { surface: setting.repo.surface, version: rollback, title: target.record?.title ?? '', event: 'откат', ...time, commit: facts.head, changes: [], reason };
    pick = ` --rollback ${rollback} --reason "${reason.replaceAll('"', '\\"')}"${values.missed ? ' --missed' : ''}`;
  } else {
    const chosen = values.amend ? chooseAmended(setting, facts, values) : choosePoint(setting, facts, ctx.workDir, values, say);
    if (!chosen) return;
    amended = chosen.amend;
    const time = amended?.record ? { at: amended.record.at, approx: amended.record.approx } : chooseTime(chosen.point, now, { missed: values.missed === true, now: values.now === true });
    if ('problem' in time) throw new UsageError(`Не записано: ${time.problem}.`, 1);
    const version = chosen.point.version ?? calendarVersion(new Date(timeOf(time.at)), facts.recorded.flatMap((r) => (r.record ? [r.record.version] : [])));
    const changelog = changelogEntry(ctx.workDir, setting, facts, version);
    const title = (stringFlag(values, 'title') ?? changelog?.title ?? amended?.record?.title ?? '').trim() || tagTitle(chosen.point, version);
    const tasks = tasksOf(ctx);
    const mainBranches = new Set([setting.repo.branch, ctx.loaded.project.repos.find((r) => r.name === ctx.currentRepo)?.branch ?? 'main', 'main', 'master']);
    const detected = detectTasks(ctx.workDir, tasks, chosen.from, chosen.point.commit, mainBranches);
    pick = `${chosen.pick}${flagsText(values)}`;

    say(`${amended ? 'Правка записи' : 'Выкатка'}: ${setting.repo.surface} ${version} — коммит ${short(chosen.point.commit)}, время записи ${time.approx ? '≈' : ''}${time.at}.`);
    say(title ? `Название: ${title}` : 'Названия у выкатки нет — добавьте --title "<коротко, что вышло>".');
    if (chosen.folded > 1) say(`С прошлой записи в ветке прода выкаток: ${chosen.folded} — эта запись закроет их одной. По отдельности — kaiten release --missed --commit <коммит>, начиная со старшей.`);
    if (chosen.fromLabel) say(`Изменения — с ${chosen.fromLabel}.`);
    if (detected.tasks.length > 0) {
      say(`Задачи в выкатке (${detected.tasks.length}):`);
      for (const t of detected.tasks) say(`  ${refOf(t)}  ${t.fm.type}  ${t.fm.title}`);
    } else say('Задач в выкатке не найдено: влитых веток задач между выкатками нет.');
    if (detected.unknown.length > 0) say(`Влитые ветки без задачи: ${detected.unknown.join(', ')}.`);

    if (!values.stdin) {
      if (apply) throw new UsageError('Не записано: нет строк изменений. Передайте их через --stdin.', 1);
      say('');
      const items = changelog?.items ?? [];
      say(items.length > 0 ? `В списке изменений проекта у этой версии пунктов: ${items.length}. Впишите каждому зону и тип, а вместо «-» в начале — задачу, если правка сделана по ней:` : 'Опишите каждое изменение строкой и передайте строки команде:');
      say('');
      say(`kaiten release${pick}${title ? '' : ' --title "<название>"'} --stdin <<'EOF'`);
      for (const item of items) say(`- | <зона> | <тип> | ${item.section ?? '-'} | ${item.text}`);
      for (const t of detected.tasks) say(`${refOf(t)} | <зона> | <тип> | - | <что изменилось для пользователя${items.length > 0 ? ' — если задачи нет в пунктах выше' : ''}>`);
      if (items.length === 0 && (detected.tasks.length === 0 || detected.unknown.length > 0)) say('- | <зона> | <тип> | - | <изменение без задачи>');
      say('EOF');
      say('');
      say(`Зоны: ${setting.zones.join(', ')}.`);
      say(`Типы: ${setting.types.join(', ')}.`);
      say('Ничего не записано.');
      return;
    }

    const parsed = parseChanges(deps.input ?? readFileSync(0, 'utf8'), setting, (ref) => {
      const found = resolveTask(tasks, ref);
      return 'error' in found ? { error: found.error } : { ref: refOf(found.task) };
    });
    const missing = parsed.problems.length === 0 ? uncoveredTasks(parsed.changes, detected.tasks.map(refOf)) : [];
    if (parsed.problems.length > 0 || missing.length > 0) {
      const lines = [...parsed.problems, ...missing.map((ref) => `задача ${ref} вошла в выкатку, а строки о ней нет. Пользователю ничего не изменилось — так и напишите, с типом из словаря`)];
      throw new UsageError(`Не записано: в строках изменений нужно исправить (${lines.length}):\n${lines.map((l) => `  ${l}`).join('\n')}`, 1);
    }
    const untitled = titleProblem(title);
    if (untitled) throw new UsageError(`Не записано: ${untitled}.`, 1);
    record = { surface: setting.repo.surface, version, title, event: 'релиз', ...time, commit: chosen.point.commit, changes: parsed.changes };
  }

  const problem = versionProblem(record.version);
  if (problem) throw new UsageError(`Не записано: ${problem}.`, 1);
  const rows = rowsOf(record);
  const tag = amended?.tag ?? recordTagName(record, facts.tagNames);
  if (!amended && record.event === 'релиз' && facts.tagNames.has(tag)) throw new UsageError(`Не записано: тег ${tag} в репозитории уже есть, а записи о выкатке в нём нет. Это вопрос к владельцу проекта.`, 1);

  let page: PageState | null = null;
  if ('client' in kaiten) {
    page = await loadPage(kaiten.client, setting.page);
    if (page.state === 'broken') throw new UsageError(`Не записано: страница журнала выкаток повреждена — ${page.problem}. ${BROKEN_FIX}`, 1);
    const key = recordKey(rows[0]);
    if (!amended && page.state === 'ok' && page.rows.some((r) => recordKey(r) === key)) throw new UsageError(`Не записано: ${record.event} ${record.version} на странице журнала уже есть.`, 1);
  }

  say('');
  for (const line of formatRows(rows)) say(line);
  say('');
  if (!apply || !('client' in kaiten)) {
    if ('missing' in kaiten) say(`Страница журнала не проверена: ${kaiten.missing}.`);
    const marks = cardMarks(setting, withRecord(facts.recorded, tag, record), record);
    if (marks.length > 0) say(`Карточкам задач будет записано поле «Релиз»: ${marks.map((m) => `${m.ref} — ${m.value}`).join('; ')}.`);
    say(`Ничего не записано. Записать: kaiten release${pick}${rollback ? '' : ' --stdin'} --apply${rollback ? '' : ' (с теми же строками)'}`);
    return;
  }

  pushRecordTag(ctx.workDir, tag, record.commit, record, amended);
  let restored = 0;
  try {
    // Страница — заново: пока отправлялся тег, её мог записать сосед.
    const fresh = await loadPage(kaiten.client, setting.page);
    if (fresh.state === 'broken') throw new UsageError(`страница журнала выкаток повреждена — ${fresh.problem}`, 1);
    const onPage = fresh.state === 'ok' ? fresh.rows : [];
    // Заодно — прежние записи этого репозитория из тегов: открытый редактор может молча вернуть
    // странице старое состояние, и пропавшие строки больше никто не заметит.
    const earlier = ownRows(setting, { recorded: facts.recorded.filter((r) => r.tag !== tag) });
    restored = missingRows(onPage, earlier).length;
    await writePage(kaiten.client, setting.page, mergeRows(onPage, [...earlier, ...rows]), rows);
  } catch (error) {
    const why = error instanceof UsageError ? error.message.replace(/^Не записано: /, '') : 'страница не записана';
    throw new UsageError(`Запись сделана наполовину: тег ${tag} отправлен, а страница журнала не обновлена — ${why}\nДопишите страницу из тега: kaiten release --rebuild --apply`, 1);
  }
  say(`${amended ? 'Запись исправлена' : 'Записано'}: ${record.event} ${record.surface} ${record.version}, строк ${rows.length}. Копия записи — в теге ${tag}.`);
  if (restored > 0) say(`На страницу возвращено строк прежних записей: ${restored} — они с неё пропали.`);
  const recorded = withRecord(facts.recorded, tag, record);
  // При правке задача могла уйти из записи: её карточке поле пересчитывается тоже.
  const touched = [...new Set([...record.changes, ...(amended?.record?.changes ?? [])].flatMap((c) => (c.task ? [c.task] : [])))];
  await markCards(kaiten.client, setting.cardProperty, cardMarks(setting, recorded, { changes: touched.map((task) => ({ task, zone: '', type: '', section: null, text: '' })) }), ctx.loaded.project.ignoreCards, say);
}

// ── название ─────────────────────────────────────────────────────────────

/** Раздел версии в списке изменений проекта; читается из ветки прода — в ней он полнее, чем в коммите выкатки. */
function changelogEntry(workDir: string, setting: On, facts: RepoFacts, version: string): ChangelogEntry | null {
  const path = setting.repo.changelog;
  if (!path) return null;
  const file = git(workDir, ['show', `refs/remotes/${facts.prodRef}:${path}`]);
  if (!file.ok) return null;
  const entries = parseChangelog(file.out);
  return entries.get(version) ?? entries.get(version.replace(/^v/, '')) ?? null;
}

/** Название из описания тега версии: «Release v1.2.3 — Оплата в окне» → «Оплата в окне». */
function tagTitle(point: DeployPoint, version: string): string {
  if (!point.version || !point.subject) return '';
  const rest = point.subject.replace(new RegExp(`^(?:release\\s+)?${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—:-]\\s*`, 'i'), '');
  return rest === point.subject ? '' : rest.replaceAll('|', '/').trim();
}

// ── поле «Релиз» на карточках ────────────────────────────────────────────

/** Записи с новой или исправленной записью на своём месте. */
function withRecord(recorded: readonly RecordedTag[], tag: string, record: ReleaseRecord): RecordedTag[] {
  return [...recorded.filter((r) => r.tag !== tag), { tag, commit: record.commit, taggedAt: new Date(timeOf(record.at)), record }];
}

interface CardMark {
  ref: string;
  cardId: number;
  /** «продукт v1.2.0, v1.3.1» — все версии, в которых выходила задача; пусто — ни в одной. */
  value: string;
}

/**
 * Что записать в поле «Релиз» карточкам задач записи: поверхность и все версии,
 * в которых задача выходила, по порядку времени. Считается по всем записям —
 * повтор и правка дают то же значение. Проект поле не завёл — пусто.
 */
function cardMarks(setting: On, recorded: readonly RecordedTag[], record: Pick<ReleaseRecord, 'changes'>): CardMark[] {
  if (setting.cardProperty === undefined) return [];
  const releases = recorded.flatMap((r) => (r.record && r.record.event === 'релиз' && r.record.surface === setting.repo.surface ? [r.record] : [])).sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const refs = [...new Set(record.changes.flatMap((c) => (c.task && /^\d+$/.test(c.task) ? [c.task] : [])))];
  return refs.map((ref) => {
    const versions = [...new Set(releases.filter((r) => r.changes.some((c) => c.task === ref)).map((r) => r.version))];
    return { ref, cardId: Number(ref), value: versions.length > 0 ? `${setting.repo.surface} ${versions.join(', ')}` : '' };
  });
}

/** Записать поле карточкам. Отказ карточки запись выкатки не отменяет: о нём говорится, а `--rebuild` доставит. */
async function markCards(client: KaitenClient, property: number | undefined, marks: readonly CardMark[], ignore: readonly number[], say: (line: string) => void): Promise<void> {
  if (property === undefined) return;
  const failed: string[] = [];
  let done = 0;
  for (const mark of marks) {
    if (ignore.includes(mark.cardId)) continue;
    try {
      await client.updateCard(mark.cardId, { properties: { [`id_${property}`]: mark.value || null } });
      done++;
    } catch {
      failed.push(mark.ref);
    }
  }
  if (done > 0) say(`Поле «Релиз» записано карточкам: ${done}.`);
  if (failed.length > 0) say(`Поле «Релиз» не записано карточкам ${failed.join(', ')}: Kaiten отказал. Повторить: kaiten release --rebuild --apply`);
}

/** Строки всех записей этого репозитория — из тегов. */
function ownRows(setting: On, facts: Pick<RepoFacts, 'recorded'>): ReleaseRow[] {
  return facts.recorded.flatMap((r) => (r.record && r.record.surface === setting.repo.surface ? rowsOf(r.record) : []));
}

/** Строки, которых на странице нет. */
function missingRows(onPage: readonly ReleaseRow[], wanted: readonly ReleaseRow[]): ReleaseRow[] {
  const present = new Set(onPage.map((r) => JSON.stringify(r)));
  return wanted.filter((r) => !present.has(JSON.stringify(r)));
}

/** Записи этого репозитория, строк которых нет на странице, — версиями; для `kaiten doctor`. */
export function recordsMissingOnPage(surface: string, recorded: readonly RecordedTag[], onPage: readonly ReleaseRow[]): string[] {
  const missing = missingRows(onPage, recorded.flatMap((r) => (r.record && r.record.surface === surface ? rowsOf(r.record) : [])));
  return [...new Set(missing.map((r) => `${r.event === 'откат' ? 'откат ' : ''}${r.version}`))];
}

/** Вернуть на страницу строки этой поверхности из тегов записей; остальное на странице не трогается. */
async function rebuild(setting: On, facts: RepoFacts, kaiten: { client: KaitenClient } | { missing: string }, apply: boolean, ignore: readonly number[], say: (line: string) => void): Promise<void> {
  if ('missing' in kaiten) throw new UsageError(`Страницу журнала не прочитать: ${kaiten.missing}.`, 1);
  const fromTags = ownRows(setting, facts);
  const page = await loadPage(kaiten.client, setting.page);
  const onPage = page.state === 'ok' ? page.rows : page.state === 'broken' ? page.salvaged : [];
  const rows = mergeRows(onPage, fromTags);
  const added = missingRows(onPage, fromTags).length;

  if (page.state === 'broken') say(`Страница журнала повреждена: ${page.problem}. Строк, которые ещё читаются: ${onPage.length} — они сохранятся.`);
  say(`Записей этого репозитория (${setting.repo.surface}): ${facts.recorded.filter((r) => r.record?.surface === setting.repo.surface).length}. На страницу вернётся строк: ${added}; всего строк станет ${rows.length}.`);
  const intact = page.state === 'ok' && added === 0 && rows.length === onPage.length;
  // Поле «Релиз» — всем задачам всех записей: карточка, которой Kaiten отказал при записи, получает его здесь.
  const marks = cardMarks(setting, facts.recorded, { changes: facts.recorded.flatMap((r) => (r.record?.surface === setting.repo.surface ? r.record.changes : [])) });
  if (intact) say('Страница в порядке, восстанавливать нечего.');
  else if (page.state === 'broken') say('Строки других репозиториев, которые не читаются, вернёт та же команда из их репозитория.');
  if (marks.length > 0) say(`Поле «Релиз» будет проставлено карточкам задач: ${marks.length}.`);
  if (intact && marks.length === 0) return;
  if (!apply) {
    say('Ничего не записано. Записать: kaiten release --rebuild --apply');
    return;
  }
  if (!intact) {
    await writePage(kaiten.client, setting.page, rows, fromTags);
    say(`Страница журнала записана: строк ${rows.length}.`);
  }
  await markCards(kaiten.client, setting.cardProperty, marks, ignore, say);
}

async function release(args: string[]): Promise<void> {
  const { values } = parse(
    'release',
    args,
    {
      apply: { type: 'boolean' },
      stdin: { type: 'boolean' },
      version: { type: 'string' },
      commit: { type: 'string' },
      missed: { type: 'boolean' },
      now: { type: 'boolean' },
      rollback: { type: 'string' },
      reason: { type: 'string' },
      rebuild: { type: 'boolean' },
      title: { type: 'string' },
      amend: { type: 'boolean' },
    },
    0,
  );
  const ctx = resolveContext();
  printNotices(ctx);
  await releaseCommand(ctx, values);
}

export const RELEASE_COMMANDS: Record<string, (args: string[]) => Promise<void>> = { release };

// ── сверка: выкатка без записи ───────────────────────────────────────────

export interface ReleaseState {
  facts: RepoFacts;
  /** Выкатки без записи, из-за которых работу начинать нельзя. */
  overdue: DeployPoint[];
}

/** Состояние журнала для репозитория; `null` — журнал не ведётся или репозиторий не читается (об этом скажет `doctor`). */
export function releaseState(workDir: string, project: ProjectConfig, repoName: string, fetch: FetchMode, now = new Date()): ReleaseState | { error: string } | null {
  const setting = releaseSetting(project, repoName);
  if (setting.state !== 'on') return null;
  // Сверка не должна держать команду: сервер не ответил за 15 секунд — судим по тому, что известно.
  const facts = readFacts(workDir, setting.repo, fetch, 15_000);
  if ('error' in facts) return facts;
  return { facts, overdue: overdue(facts, now) };
}

/** Выкатка без записи: что не так и что сделать; `null` — всё записано или ещё свежо. */
export function releaseProblem(state: ReleaseState): { what: string; fix: string } | null {
  if (state.facts.rolledBack) {
    const v = state.facts.rolledBack.version;
    return {
      what: `ветку прода откатили с версии ${v}, а записи об откате в журнале выкаток нет`,
      fix: `Запишите откат: kaiten release --rollback ${v} --reason "<почему>" — команда покажет запись, затем повторите с --apply`,
    };
  }
  if (state.overdue.length === 0) return null;
  const many = state.overdue.length > 1;
  const pick = many ? (state.overdue[0].version ? ` --version ${state.overdue[0].version}` : ` --commit ${short(state.overdue[0].commit)}`) : '';
  return {
    what: `в проде ${many ? `есть выкатки (${state.overdue.length})` : 'есть выкатка'} без записи в журнале выкаток:${listPoints(state.overdue, 5)}`,
    fix: `Запишите ${many ? 'их, начиная со старшей' : 'её'}: kaiten release --missed${pick} — команда покажет, что написать`,
  };
}

/**
 * Что мешает начать работу в этом репозитории: выкатка без записи в журнале.
 * `null` — ничего. Репозиторий, который не читается, работу не останавливает:
 * отказ должен называть то, что человек может исправить.
 */
export function releaseGateProblem(ctx: Context, now = new Date()): string | null {
  const state = releaseState(ctx.workDir, ctx.loaded.project, ctx.currentRepo, 'try', now);
  if (!state || 'error' in state) return null;
  const problem = releaseProblem(state);
  return problem ? `${problem.what}\n${problem.fix}` : null;
}
