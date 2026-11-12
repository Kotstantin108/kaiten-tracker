/**
 * Гейты сдачи работы — чистая часть (`docs/review-gates.md`).
 *
 * ЗАЧЕМ. Агенты пишут код быстрее, чем люди его читают. Раньше `kaiten review`
 * проверял только отметки критериев, запись в журнале и «Было / Стало»: слова
 * «тесты прошли» в журнале оставались словами. Теперь проект называет в
 * `kaiten.json`, без чего работу сдавать нельзя, а проверяет это инструмент.
 *
 * ДВА ГЕЙТА, оба выключены, пока проект их не задал (`review` в `kaiten.json`):
 *   · проверки (`review.checks`) — команды проекта. Их запускает `kaiten verify`
 *     и пишет в задачу свидетельство: на каком коммите шли и прошли ли
 *     (`checks` в шапке задачи — поле CLI, правкой текста его не поставить).
 *     `kaiten review` принимает работу, только если свидетельство — об успехе
 *     всех нынешних проверок и именно на текущем коммите ветки: коммит после
 *     прогона его обесценивает, незакоммиченное — тоже;
 *   · документация (`review.docs`) — в изменениях ветки задачи есть файл под
 *     названными путями, или причина словами (`--no-ingest`).
 *
 * Гейты — для задач с кодом: story, tech, bug. У спайка результат — ответ, эпик
 * на ревью не сдают.
 *
 * Здесь — решения и тексты. Git и запуск команд — в `kaiten-verify.ts`.
 */

import type { Frontmatter, TaskType } from './schema.js';

export const GATED_TYPES: readonly TaskType[] = ['story', 'tech', 'bug'];

/** Применимы ли гейты сдачи к задаче этого типа. */
export function gatesApply(type: TaskType): boolean {
  return GATED_TYPES.includes(type);
}

export type ChecksEvidence = NonNullable<Frontmatter['checks']>;

// ── итог прогона ─────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  /** `skipped` — не запускалась: раньше упала другая. */
  outcome: 'passed' | 'failed' | 'skipped';
  ms: number;
  /** Проверка не уложилась в свой предел времени (минуты). */
  timedOutMin?: number;
}

export function allPassed(results: readonly CheckResult[]): boolean {
  return results.length > 0 && results.every((r) => r.outcome === 'passed');
}

/** Длительность для человека: «0,4 с», «12 с», «3 мин 05 с». */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(Math.max(ms, 0) / 1000).toFixed(1).replace('.', ',')} с`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  return `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} с`;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 10);
}

function resultWords(result: CheckResult): string {
  if (result.outcome === 'skipped') return `${result.name} — не запускалась`;
  if (result.timedOutMin !== undefined) return `${result.name} — не прошла: дольше ${result.timedOutMin} мин`;
  return `${result.name} — ${result.outcome === 'passed' ? 'прошла' : 'не прошла'} (${formatDuration(result.ms)})`;
}

/** Запись в журнал задачи об итоге прогона: только имена, исход и время — вывода проверок здесь нет. */
export function verifyEntry(results: readonly CheckResult[], commit: string): string {
  return `проверки ${allPassed(results) ? 'пройдены' : 'не пройдены'}: ${results.map(resultWords).join(', ')}; коммит ${shortCommit(commit)}`;
}

/** Начало записи `verifyEntry` — чтобы не считать её записью о работе (`hasWorkNote`). */
export const VERIFY_ENTRY_RE = String.raw`проверки (?:не )?пройдены:`;

// ── гейт проверок ────────────────────────────────────────────────────────

export interface ChecksGateInput {
  /** Ключ задачи — для готовой команды в отказе. */
  ref: string;
  /** Текущий коммит ветки (полный хеш). */
  head: string;
  /** Есть ли в рабочей копии незакоммиченное. */
  dirty: boolean;
  /** Свидетельство из задачи. */
  evidence?: ChecksEvidence;
  /** Имена проверок, которые проект требует сейчас. */
  wanted: readonly string[];
}

/** Подтверждает ли свидетельство все нынешние проверки на этом коммите. */
export function evidenceCovers(evidence: ChecksEvidence | undefined, head: string, wanted: readonly string[]): boolean {
  return evidence !== undefined && evidence.passed && evidence.commit === head && wanted.every((name) => evidence.names.includes(name));
}

/**
 * Что мешает сдать работу по гейту проверок; `null` — ничего. Отказ называет
 * одну причину (она известна точно) и одну команду.
 */
export function checksGateProblem(input: ChecksGateInput): string | null {
  const run = `kaiten verify ${input.ref}`;
  if (input.dirty) return `в рабочей копии есть незакоммиченные изменения, а проверки проекта подтверждают только коммит. Закоммитьте их и запустите: ${run}`;
  const { evidence } = input;
  if (!evidence) return `проверки проекта по задаче не запускались. Запустите: ${run}`;
  if (evidence.commit !== input.head) {
    return `проверки проекта шли на коммите ${shortCommit(evidence.commit)}, а сейчас в ветке ${shortCommit(input.head)}: коммит после прогона его обесценивает. Запустите: ${run}`;
  }
  if (!evidence.passed) return `проверки проекта на коммите ${shortCommit(input.head)} не прошли. Исправьте, закоммитьте и запустите: ${run}`;
  const missing = input.wanted.filter((name) => !evidence.names.includes(name));
  if (missing.length > 0) return `с прошлого прогона у проекта появились проверки (${missing.join(', ')}). Запустите: ${run}`;
  return null;
}

// ── гейт документации ────────────────────────────────────────────────────

// Шаблон пути → регулярное выражение. `*` — внутри одной папки, `**` — через
// папки (шаблон «**/README.md» находит и README.md в корне), `?` — один знак.
// Путь — от корня репозитория, через прямой слэш.
export function globToRegExp(glob: string): RegExp {
  const g = glob
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/$/, '/**');
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Файлы под путями документации. Шаблон-папка без звёздочек (`docs`) — всё, что в ней. */
export function docsTouched(changed: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs.map(globToRegExp);
  const matches = (path: string): boolean => {
    const parts = path.replace(/\\/g, '/').split('/');
    // Сам путь и каждая папка над ним: `docs` находит `docs/api/auth.md`.
    return parts.some((_, i) => patterns.some((re) => re.test(parts.slice(0, i + 1).join('/'))));
  };
  return changed.filter(matches);
}

export interface DocsGateInput {
  ref: string;
  /** Пути документации проекта. */
  globs: readonly string[];
  /** Файлы, изменённые в ветке задачи от общего предка с основной; `null` — основной ветки в репозитории нет. */
  changed: readonly string[] | null;
  /** Основная ветка — для отказа, когда её нет. */
  mainBranch: string;
  /** Причина из `--no-ingest`; `undefined` — флага нет. */
  noIngest?: string;
}

/** Запись для журнала — или что исправить. */
export type DocsDecision = { note: string } | { problem: string };

/** Гейт документации для `kaiten review` — по образцу «Было / Стало»: правка в ветке или причина словами. */
export function docsDecision(input: DocsGateInput): DocsDecision {
  const touched = input.changed ? docsTouched(input.changed, input.globs) : [];
  if (input.noIngest !== undefined) {
    const why = input.noIngest.trim();
    if (!why) return { problem: '--no-ingest: напишите, почему документация не меняется' };
    if (touched.length > 0) return { problem: `--no-ingest, а в изменениях ветки есть документация (${listed(touched)}) — уберите флаг: правка и есть ответ` };
    return { note: `документация не обновлена: ${why}` };
  }
  if (input.changed === null) {
    return {
      problem:
        `в репозитории нет основной ветки ${input.mainBranch}, от которой считаются изменения задачи. Получите её: git fetch origin ${input.mainBranch} — и повторите. ` +
        `Документация не меняется — скажите почему: kaiten review ${input.ref} --no-ingest "<почему>"`,
    };
  }
  if (touched.length === 0) {
    return {
      problem:
        `в изменениях ветки нет документации (${input.globs.join(', ')}). Обновите страницу модуля, который меняли, закоммитьте и повторите. ` +
        `Документация не меняется — скажите почему: kaiten review ${input.ref} --no-ingest "<почему>"`,
    };
  }
  return { note: `документация: ${listed(touched)}` };
}

function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} и ещё ${paths.length - 3}` : shown;
}

// ── вывод упавшей проверки ───────────────────────────────────────────────

export const TAIL_LINES = 40;
export const TAIL_CHARS = 4000;

/** Хвост вывода упавшей проверки: последние строки в разумном пределе — агенту, не в журнал. */
export function outputTail(output: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): string {
  // Управляющие последовательности терминала (цвет, перерисовка строки) в тексте только мешают.
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\r\n/g, '\n').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^\n]*\r(?!\n)/g, '');
  const lines = clean.split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let tail = lines.slice(-maxLines).join('\n');
  if (tail.length > maxChars) tail = tail.slice(-maxChars).replace(/^[^\n]*\n/, '');
  return tail;
}
