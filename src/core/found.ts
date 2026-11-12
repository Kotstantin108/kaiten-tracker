/**
 * «Находки» — чистая часть: заметка о дефекте, задание исследователю, проверка
 * его ответа и карточка бага (владелец 12.11.2026).
 *
 * ЗАЧЕМ. Агент, занятый своей задачей, замечает дефекты рядом. Раньше он сразу
 * заводил задачу — посреди большой работы, с чужим контекстом в голове, — а
 * задачам в Kaiten верят и берут их в работу. Теперь он оставляет заметку
 * (`kaiten found`), а постановку пишет исследователь с чистым контекстом.
 *
 * ПУТЬ НАХОДКИ.
 *   1. Заметка `findings/<id>.md` в репозитории задач: что видели, где, из
 *      какой задачи. Состояние `pending` — «не исследована».
 *   2. Исследование — отдельный запуск модели только на чтение, по снимку
 *      ОСНОВНОЙ ветки (не рабочей папки: там недоделанная работа) и по задачам
 *      проекта. Ответ — по схеме `FindingAnswerSchema`.
 *   3. Проверка ответа (`verifyFinding`) — механическая: каждое доказательство
 *      сверяется со снимком. Подтверждено — задача типа bug в статусе `found`
 *      («Находки»). Всё остальное — заметка с вердиктом и причиной: не
 *      подтверждено — значит опровергнуто, карточки нет.
 *
 * ЧТО СЧИТАЕТСЯ ДОКАЗАННЫМ ДЕФЕКТОМ. Три вещи: что происходит (место в коде
 * основной ветки), как воспроизвести и откуда известно, как должно быть (тест,
 * документ, задача проекта, явный контракт в коде). Третье отсекает улучшения:
 * у «мне кажется, лучше иначе» источника нет.
 *
 * ЧЕГО ИССЛЕДОВАТЕЛЬ НЕ ДЕЛАЕТ. Не пишет никуда: карточку собирает и
 * записывает инструмент. Не заполняет разделы для младших (продукт, БД, n8n):
 * это допуск, а не описание находки. Из «Находок» задачу выносит человек.
 */

import { stringify } from 'yaml';
import { z } from 'zod';

import { parseTaskDocument, TaskParseError } from './document.js';
import { SLUG_RE, SUMMARY_MAX } from './lint.js';
import { ULID_RE } from './schema.js';
import { newBodyProblems, sectionText } from './skeleton.js';
import { refOf, type TaskRecord } from './tasks-index.js';

// ── заметка ──────────────────────────────────────────────────────────────

export const FINDINGS_DIR = 'findings';

/** `pending` — не исследована; остальные — вердикт исследования. */
export const FINDING_STATES = ['pending', 'confirmed', 'rejected', 'duplicate'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export function findingPath(id: string): string {
  return `${FINDINGS_DIR}/${id}.md`;
}

export function isFindingPath(path: string): boolean {
  return path.startsWith(`${FINDINGS_DIR}/`);
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата в формате YYYY-MM-DD');
const nonEmpty = z.string().trim().min(1, 'пустое значение');

const FindingFmSchema = z
  .object({
    id: z.string().regex(ULID_RE, 'ULID из 26 символов'),
    state: z.enum(FINDING_STATES),
    /** Репозиторий кода, в котором нашли. */
    repo: nonEmpty,
    /** Задача, по ходу которой нашли (slug). */
    from: nonEmpty.optional(),
    created: date,
    created_by: nonEmpty,
    resolved: date.optional(),
    /** `confirmed` — заведённая задача; `duplicate` — задача, где дефект уже записан (slug). */
    task: nonEmpty.optional(),
  })
  .strict();
export type FindingFm = z.infer<typeof FindingFmSchema>;

export interface Finding {
  fm: FindingFm;
  /** Что не так — одной строкой. */
  title: string;
  /** Где: файл, строка, экран. */
  where: string;
  /** Что видели и почему это похоже на дефект. */
  seen: string;
  /** Причина вердикта; у неисследованной — `null`. */
  reason: string | null;
}

const SECTION_WHERE = 'Где';
const SECTION_SEEN = 'Что видели';
const SECTION_VERDICT = 'Вердикт';

const FM_ORDER = ['id', 'state', 'repo', 'from', 'created', 'created_by', 'resolved', 'task'] as const;

export function serializeFinding(finding: Finding): string {
  const fm: Record<string, unknown> = {};
  for (const key of FM_ORDER) if (finding.fm[key] !== undefined) fm[key] = finding.fm[key];
  const parts = [`# ${finding.title}`, `## ${SECTION_WHERE}\n\n${finding.where}`, `## ${SECTION_SEEN}\n\n${finding.seen}`];
  if (finding.reason !== null) parts.push(`## ${SECTION_VERDICT}\n\n${finding.reason}`);
  return `---\n${stringify(fm, { lineWidth: 0, minContentWidth: 0 })}---\n${parts.join('\n\n')}\n`;
}

/** Заголовки в тексте агента сломали бы разбор заметки — понижаем до обычных строк. */
function plain(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^(\s*)#{1,6}[ \t]+/, '$1'))
    .join('\n')
    .trim();
}

export interface NewFindingInput {
  id: string;
  repo: string;
  from?: string;
  createdBy: string;
  title: string;
  where: string;
  seen: string;
}

/** Текст новой заметки или что в ней не так. */
export function newFindingText(input: NewFindingInput, today: string): string | { error: string } {
  const title = input.title.replace(/\s+/g, ' ').trim();
  const where = plain(input.where);
  const seen = plain(input.seen);
  if (!title) return { error: 'не сказано, что не так' };
  if (!where) return { error: 'не сказано, где это видно' };
  if (!seen) return { error: 'не сказано, почему это дефект' };
  const fm = FindingFmSchema.safeParse({ id: input.id, state: 'pending', repo: input.repo, from: input.from, created: today, created_by: input.createdBy });
  if (!fm.success) return { error: fm.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return serializeFinding({ fm: fm.data, title, where, seen, reason: null });
}

export function parseFinding(text: string): Finding | { error: string } {
  let raw;
  try {
    raw = parseTaskDocument(text);
  } catch (error) {
    if (error instanceof TaskParseError) return { error: error.message };
    throw error;
  }
  const fm = FindingFmSchema.safeParse(raw.data);
  if (!fm.success) return { error: fm.error.issues.map((i) => `${i.path.join('.') || '(шапка)'}: ${i.message}`).join('; ') };
  const title = /^#[ \t]+(.+?)[ \t]*$/m.exec(raw.body)?.[1] ?? '';
  const where = sectionText(raw.body, SECTION_WHERE)?.trim() ?? '';
  const seen = sectionText(raw.body, SECTION_SEEN)?.trim() ?? '';
  if (!title || !where || !seen) return { error: 'в заметке нет заголовка, раздела «Где» или «Что видели»' };
  const reason = sectionText(raw.body, SECTION_VERDICT)?.trim();
  return { fm: fm.data, title, where, seen, reason: reason ? reason : null };
}

/** Заметки из файлов репозитория задач; нечитаемые пропускаются — это не повод остановить команду. */
export function listFindings(files: ReadonlyArray<{ path: string; text: string }>): Finding[] {
  return files
    .filter((f) => isFindingPath(f.path) && f.path.endsWith('.md'))
    .sort((a, b) => a.path.localeCompare(b.path))
    .flatMap((f) => {
      const parsed = parseFinding(f.text);
      return 'error' in parsed ? [] : [parsed];
    });
}

/**
 * Что исследует проверка находок: только заметки `kaiten found`, которые ещё не
 * исследованы. Задачи проекта сюда не попадают никогда — и заведённые агентом
 * тоже: задача из `kaiten new` — работа на разбор человеку (владелец 12.11.2026,
 * после того как разбор «старых задач агентов» отменил поставленную работу).
 */
export function pendingFindings(files: ReadonlyArray<{ path: string; text: string }>): Finding[] {
  return listFindings(files).filter((f) => f.fm.state === 'pending');
}

export const FINDING_STATE_WORDS: Record<FindingState, string> = {
  pending: 'не исследована',
  confirmed: 'подтверждена',
  rejected: 'не подтверждена',
  duplicate: 'уже записана',
};

// ── ответ исследователя ──────────────────────────────────────────────────

/** Папки снимка, который видит исследователь. */
export const SNAPSHOT_CODE = 'code';
export const SNAPSHOT_TASKS = 'tasks';

export const FINDING_VERDICTS = ['confirmed', 'rejected', 'duplicate'] as const;

const EvidenceSchema = z
  .object({
    role: z.enum(['actual', 'expected']).describe('actual — место, где дефект происходит; expected — откуда известно, как должно быть'),
    path: z.string().describe(`Путь к файлу от текущей папки: ${SNAPSHOT_CODE}/… или ${SNAPSHOT_TASKS}/…`),
    line: z.number().int().describe('Номер строки в этом файле'),
    quote: z.string().describe('Одна строка этого файла дословно, не короче 10 знаков'),
    note: z.string().describe('Что эта строка доказывает'),
  })
  .strict();

/**
 * Ответ исследователя — структурированный вывод `claude -p --json-schema`. Все
 * поля обязательны, ненужное — пустой строкой или пустым списком: так схема
 * проще и модели, и проверке.
 */
export const FindingAnswerSchema = z
  .object({
    verdict: z.enum(FINDING_VERDICTS).describe('confirmed — дефект доказан по основной ветке; duplicate — он уже записан задачей; rejected — всё остальное'),
    reason: z.string().describe('Почему такой вердикт: 2–5 коротких предложений по-русски, без терминов, которых нет в коде'),
    duplicate_of: z.string().describe('Для duplicate — имя файла задачи без .md; иначе пустая строка'),
    title: z.string().describe('Для confirmed — заголовок задачи с глагола: «Починить…»; иначе пустая строка'),
    slug: z.string().describe('Для confirmed — короткое имя задачи латиницей через дефис: fix-…; иначе пустая строка'),
    summary: z.string().describe(`Для confirmed — суть для человека без знания кода, 1–3 предложения, до ${SUMMARY_MAX} знаков; иначе пустая строка`),
    what_happens: z.string().describe('Для confirmed — что сломано, где и кого задевает; иначе пустая строка'),
    reproduce: z.string().describe('Для confirmed — шаги воспроизведения нумерованным списком; иначе пустая строка'),
    expected: z.string().describe('Для confirmed — как должно быть и откуда это известно; иначе пустая строка'),
    criteria: z.array(z.string()).describe('Для confirmed — по чему проверят, что исправлено: хотя бы один пункт; иначе пустой список'),
    evidence: z.array(EvidenceSchema).describe('Для confirmed — хотя бы одно actual и одно expected; иначе можно пусто'),
  })
  .strict();
export type FindingAnswer = z.infer<typeof FindingAnswerSchema>;

export interface FindingCheck {
  /** Текст файла снимка по пути от его корня; `null` — файла нет. */
  readFile: (path: string) => string | null;
  /** Задача проекта по имени файла, ключу или id. */
  findTask: (ref: string) => TaskRecord | null;
}

/** Основная ветка, по которой исследовали: имя и коммит. */
export interface SnapshotHead {
  branch: string;
  commit: string;
}

export type FindingVerdict =
  | { state: 'confirmed'; reason: string; task: { title: string; slug: string; summary: string; body: string } }
  | { state: 'duplicate'; reason: string; of: TaskRecord }
  | { state: 'rejected'; reason: string };

/** Путь внутри снимка: относительный, без выхода наружу. */
function snapshotPath(path: string): string | null {
  const p = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((part) => part === '..' || part === '')) return null;
  return p;
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const QUOTE_MIN = 10;

interface CheckedEvidence {
  role: 'actual' | 'expected';
  path: string;
  line: number;
  note: string;
}

/** Строка файла, где стоит цитата: ближайшая к названной; `null` — цитаты в файле нет. */
function quoteLine(text: string, quote: string, near: number): number | null {
  const wanted = squash(quote);
  let best: number | null = null;
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (!squash(line).includes(wanted)) return;
      const at = i + 1;
      if (best === null || Math.abs(at - near) < Math.abs(best - near)) best = at;
    });
  return best;
}

function checkEvidence(answer: FindingAnswer, check: FindingCheck, problems: string[]): CheckedEvidence[] {
  const out: CheckedEvidence[] = [];
  for (const e of answer.evidence) {
    const path = snapshotPath(e.path);
    const shown = `${e.path}:${e.line}`;
    if (path === null) {
      problems.push(`путь вне снимка: ${shown}`);
      continue;
    }
    const inCode = path.startsWith(`${SNAPSHOT_CODE}/`);
    const inTasks = path.startsWith(`${SNAPSHOT_TASKS}/`);
    if (!inCode && !inTasks) {
      problems.push(`файл не из кода и не из задач: ${shown}`);
      continue;
    }
    // Дефект происходит в коде продукта: текст задачи его местом быть не может.
    if (e.role === 'actual' && !inCode) {
      problems.push(`место дефекта названо не в коде: ${shown}`);
      continue;
    }
    const text = check.readFile(path);
    if (text === null) {
      problems.push(`в основной ветке нет файла ${shown}`);
      continue;
    }
    if (squash(e.quote).length < QUOTE_MIN) {
      problems.push(`цитата короче ${QUOTE_MIN} знаков: ${shown}`);
      continue;
    }
    const line = quoteLine(text, e.quote, e.line);
    if (line === null) {
      problems.push(`в основной ветке нет такой строки: ${shown}`);
      continue;
    }
    if (!e.note.trim()) {
      problems.push(`не сказано, что доказывает: ${shown}`);
      continue;
    }
    out.push({ role: e.role, path, line, note: squash(e.note) });
  }
  return out;
}

/** Путь снимка — так, как его прочтёт человек в карточке. */
function shownPath(e: CheckedEvidence): string {
  if (e.path.startsWith(`${SNAPSHOT_CODE}/`)) return `\`${e.path.slice(SNAPSHOT_CODE.length + 1)}:${e.line}\``;
  // Задача — ссылкой: синхронизация превратит её в ссылку на репозиторий задач.
  const taskPath = e.path.slice(SNAPSHOT_TASKS.length);
  const name = taskPath.split('/').at(-1)?.replace(/(?:\.log)?\.md$/, '') ?? taskPath;
  return /^\/(?:active|archive\/\d{4}-\d{2})\/[a-z0-9-]+\.md$/.test(taskPath) ? `[задача ${name}](${taskPath})` : `задача ${name}`;
}

function checklist(items: readonly string[]): string {
  return items.map((item) => `- [ ] ${squash(item).replace(/^[-*+]\s*(?:\[[ xX]\]\s*)?/, '')}`).join('\n');
}

/** Тело задачи-находки: разделы бага и «Доказательства». */
export function findingTaskBody(answer: FindingAnswer, evidence: readonly CheckedEvidence[], finding: Finding, head: SnapshotHead): string {
  const lines = (role: CheckedEvidence['role']): string[] => evidence.filter((e) => e.role === role).map((e) => `- ${shownPath(e)} — ${e.note}`);
  return [
    `## Что происходит\n\n${answer.what_happens.trim()}`,
    `## Как воспроизвести\n\n${answer.reproduce.trim()}`,
    `## Как должно быть\n\n${answer.expected.trim()}`,
    `## Критерии\n\n${checklist(answer.criteria)}`,
    [
      '## Доказательства',
      '',
      `Находка агента, подтверждена исследованием по ветке ${head.branch} (коммит ${head.commit.slice(0, 10)}). К работе не разобрана: из «Находок» её выносит человек.`,
      '',
      `Заметка агента: ${finding.title}. Где: ${squash(finding.where)}.`,
      '',
      'Где дефект:',
      ...lines('actual'),
      '',
      'Откуда известно, как должно быть:',
      ...lines('expected'),
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Ответ исследователя → вердикт. Подтверждение — только когда сошлось всё:
 * любая нестыковка делает находку неподтверждённой, а не «почти доказанной».
 */
export function verifyFinding(finding: Finding, answer: FindingAnswer, check: FindingCheck, head: SnapshotHead): FindingVerdict {
  const reason = squash(answer.reason) || 'исследователь не объяснил вердикт';
  if (answer.verdict === 'rejected') return { state: 'rejected', reason };

  if (answer.verdict === 'duplicate') {
    const of = check.findTask(answer.duplicate_of.trim().replace(/\.md$/, ''));
    if (!of) return { state: 'rejected', reason: `исследователь назвал находку повтором задачи «${answer.duplicate_of.trim() || '?'}», а такой задачи нет. ${reason}` };
    return { state: 'duplicate', reason, of };
  }

  const problems: string[] = [];
  const title = squash(answer.title);
  const slug = answer.slug.trim();
  const summary = squash(answer.summary);
  if (!title) problems.push('нет заголовка задачи');
  if (!SLUG_RE.test(slug)) problems.push('имя задачи — не латиница через дефис');
  if (!summary) problems.push('нет сути');
  else if (summary.length > SUMMARY_MAX) problems.push(`суть длиннее ${SUMMARY_MAX} знаков`);
  if (answer.criteria.filter((c) => squash(c)).length === 0) problems.push('нет критериев');

  const evidence = checkEvidence(answer, check, problems);
  if (!evidence.some((e) => e.role === 'actual')) problems.push('нет места в коде основной ветки, где дефект происходит');
  if (!evidence.some((e) => e.role === 'expected')) problems.push('не показано, откуда известно, как должно быть: это улучшение, а не дефект');

  const body = findingTaskBody({ ...answer, criteria: answer.criteria.filter((c) => squash(c)) }, evidence, finding, head);
  if (problems.length === 0) problems.push(...newBodyProblems('bug', body));

  if (problems.length > 0) return { state: 'rejected', reason: `Ответ исследователя не прошёл сверку с основной веткой: ${problems.join('; ')}. Он писал: ${reason}` };
  return { state: 'confirmed', reason, task: { title, slug, summary, body } };
}

// ── задание исследователю ────────────────────────────────────────────────

export interface FindingPromptInput {
  finding: Finding;
  head: SnapshotHead;
  /** Задача, по ходу которой нашли, — если она есть среди задач. */
  from: TaskRecord | null;
}

/** Задание исследователю по одной заметке: что видели, где смотреть, что ответить. */
export function findingPrompt({ finding, head, from }: FindingPromptInput): string {
  return [
    'Ты проверяешь находку: другой агент, занятый своей задачей, заметил в продукте что-то похожее на дефект и оставил заметку. Он мог ошибиться — у него был чужой контекст и недоделанный код перед глазами. Твоё дело — проверить по коду основной ветки, дефект ли это.',
    'Ты только читаешь: Read, Grep, Glob. Ничего не меняй и не запускай.',
    '',
    'Что перед тобой (пути — от текущей папки):',
    `- ${SNAPSHOT_CODE}/ — код репозитория ${finding.fm.repo}, ветка ${head.branch}, коммит ${head.commit.slice(0, 10)}. Других веток и чужой недоделанной работы здесь нет;`,
    `- ${SNAPSHOT_TASKS}/active/ и ${SNAPSHOT_TASKS}/archive/ — задачи проекта, открытые и закрытые: файл \`<имя>.md\` — постановка, \`<имя>.log.md\` — журнал работы;`,
    `- ${FINDINGS_DIR}/ — прежние находки с вердиктами.`,
    '',
    'Вердикт:',
    '- confirmed — дефект доказан. Нужны все три вещи: (1) место в коде, где он происходит; (2) шаги, которыми он воспроизводится; (3) источник того, как должно быть: тест, документ, задача проекта или явный контракт в коде (тип, проверка, комментарий, соседний вызов, который делает правильно);',
    `- duplicate — дефект уже записан задачей в ${SNAPSHOT_TASKS}/ (открытой или закрытой как «не делаем»). Сначала поищи: Grep по ${SNAPSHOT_TASKS}/ словами заметки и именами из кода;`,
    '- rejected — всё остальное: в основной ветке этого нет или оно уже исправлено; это улучшение, рефакторинг, стиль, недостающий тест или пожелание, а не нарушение того, как должно быть; источника «как должно быть» нет; для доказательства нужен другой репозиторий или живые данные, которых здесь нет; та же находка уже отклонена и нового довода нет.',
    'Сомневаешься между confirmed и rejected — rejected. Ложная находка станет карточкой, которой поверят и возьмут в работу; неподтверждённая просто останется заметкой.',
    '',
    'Доказательство (evidence) — файл, номер строки и сама строка дословно. role actual — место дефекта, только из code/. role expected — источник того, как должно быть, из code/ или tasks/. Каждое доказательство сверяется автоматически: нет такого файла или строки — находка считается неподтверждённой целиком.',
    '',
    'Для confirmed напиши задачу так, чтобы её понял человек, не видевший заметки:',
    '- title — с глагола, что починить; summary — суть без терминов кода;',
    '- what_happens — что сломано, где и кого задевает; reproduce — нумерованные шаги; expected — как должно быть и откуда это известно;',
    '- criteria — проверяемые пункты, по которым примут исправление.',
    'Как чинить — не пиши: это решит тот, кто возьмёт задачу. Соседние недочёты, не относящиеся к этой находке, не добавляй.',
    '',
    'Заметка агента:',
    '',
    `Что не так: ${finding.title}`,
    `Где: ${finding.where}`,
    `Что он видел и почему решил, что это дефект: ${finding.seen}`,
    from ? `Нашёл по ходу задачи ${refOf(from)} «${from.fm.title}» (${SNAPSHOT_TASKS}/${from.path}) — её собственная недоделанная работа дефектом не считается.` : 'Из какой задачи нашёл — не сказано.',
  ].join('\n');
}

// ── отчёт ────────────────────────────────────────────────────────────────

/** Строка о находке для списка и отчёта владельца. */
export function findingLine(finding: Finding): string {
  const task = finding.fm.task ? ` → ${finding.fm.task}` : '';
  return `${finding.fm.id}  ${FINDING_STATE_WORDS[finding.fm.state]}${task}  ${finding.fm.created}  ${finding.title}`;
}
