/**
 * Признак «Можно младшему» (docs/junior-readiness.md): задачу можно брать
 * младшему разработчику, если она свежая, а продуктовые решения, изменения
 * в БД и сценарии n8n в ней либо явно отсутствуют («Нет»), либо описаны
 * всеми пунктами. Вычисляется из файла задачи механически, без сети.
 *
 * Разделы необязательны: нет раздела или пункта — не отказ, а «Нет» с
 * причиной, которую видит команда в поле карточки.
 */

import type { AssessVerdict, Frontmatter, TaskStatus, TaskType } from './schema.js';
import { filledText, sectionText, SKELETONS } from './skeleton.js';

interface JuniorSection {
  /** Заголовок `## …` в теле задачи. */
  name: string;
  /** Как раздел называется в причинах. */
  short: string;
  /** Пункты `**Метка:** текст`, обязательные, когда раздел не «Нет». */
  labels: readonly string[];
  /** Заготовки каркаса: первая строка — когда писать «Нет», дальше — по пункту. */
  intro: string;
  hints: readonly string[];
}

export const JUNIOR_SECTIONS: readonly JuniorSection[] = [
  {
    name: 'Продуктовые решения',
    short: 'продукт',
    labels: ['Что решено', 'Где зафиксировано', 'Открытые вопросы'],
    intro: '«Нет», если задача не требует продуктовых решений',
    hints: ['поведение для пользователя: тексты, правила, граничные случаи', 'ссылка на обсуждение, документ, макет или кто решил', 'нет — иначе задача не для младшего'],
  },
  {
    name: 'Изменения в БД',
    short: 'БД',
    labels: ['Что меняется', 'Миграция', 'Откат', 'Как проверить'],
    intro: '«Нет», если проверили по коду, что БД не меняется',
    hints: ['таблицы и поля: создать, изменить, удалить', 'как переносятся существующие данные', 'как вернуть назад', 'запрос или сценарий, по которому видно, что всё верно'],
  },
  {
    name: 'Сценарии n8n',
    short: 'n8n',
    labels: ['Сценарий', 'Что меняется', 'Входы и выходы', 'Как проверить'],
    intro: '«Нет», если проверили, что сценарии n8n не затрагиваются',
    hints: ['название или ссылка на workflow; новый — «новый: …»', 'узлы и логика', 'что приходит, что отдаётся, кто от этого зависит', 'тестовый запуск: входные данные и ожидаемый результат'],
  },
];

/** Пункт, где годится только «нет»: открытый продуктовый вопрос — задача не для младшего. */
const MUST_BE_NO = 'Открытые вопросы';

export const JUNIOR_TYPES: readonly TaskType[] = ['story', 'tech', 'bug'];
/**
 * Задачи, которые ещё можно взять и которые разобрал человек; у остальных признака нет.
 * «Находки» и «Входящие» — до разбора: постановку там мог написать агент, и «Нет» в
 * разделах было бы его же свидетельством о собственной находке (владелец 12.11.2026).
 */
export const JUNIOR_STATUSES: readonly TaskStatus[] = ['backlog', 'ready'];
/** Что оценивает `pnpm run assess`: и неразобранное — «похоже, сделана» полезно знать до разбора. */
export const ASSESS_STATUSES: readonly TaskStatus[] = ['inbox', 'backlog', 'ready'];

/** `null` — признак к задаче не применим (тип или статус); иначе — годится ли и чего не хватает. */
export type JuniorReadiness = { ok: boolean; missing: string[] } | null;

export interface JuniorOptions {
  /** Сегодня, YYYY-MM-DD. */
  today: string;
  maxAgeDays: number;
}

/** Оценки, с которыми задача не для младшего, — словами для поля карточки. */
const ASSESS_PROBLEMS: Partial<Record<AssessVerdict, string>> = { done: 'оценка: похоже, сделана', obsolete: 'оценка: похоже, устарела' };

type ReadinessFields = Pick<Frontmatter, 'type' | 'status' | 'created' | 'revised' | 'assessment' | 'assessed'>;

/**
 * Возраст — от последней правки текста (`revised`), а не от `updated`: перенос
 * карточки по доске, приоритет или отметка пункта постановку не освежают.
 * Задача до поля `revised` — от `created`: лучше лишнее «Нет», чем «Да» наугад.
 * «Актуальна» от скрипта оценки освежает задачу так же, как правка (`freshSince`).
 */
export function juniorReadiness(fm: ReadinessFields, body: string, opts: JuniorOptions): JuniorReadiness {
  if (!JUNIOR_TYPES.includes(fm.type) || !JUNIOR_STATUSES.includes(fm.status)) return null;
  const missing: string[] = [];
  if (daysBetween(freshSince(fm), opts.today) > opts.maxAgeDays) missing.push(`постановку не правили больше ${opts.maxAgeDays} дней`);
  for (const section of JUNIOR_SECTIONS) missing.push(...sectionProblems(section, sectionText(body, section.name)));
  const assessed = fm.assessment === undefined ? undefined : ASSESS_PROBLEMS[fm.assessment];
  if (assessed) missing.push(assessed);
  return { ok: missing.length === 0, missing };
}

/** Чья оценка у задачи: скрипта (в Kaiten стоит то, что он поставил), человека или ничья. */
export function assessedBy(fm: Pick<Frontmatter, 'assessment' | 'assessed'>): 'script' | 'human' | null {
  if (fm.assessment === undefined) return null;
  return fm.assessed?.verdict === fm.assessment ? 'script' : 'human';
}

/**
 * С какого дня задача свежая: правка текста или «Актуальна» от скрипта
 * оценки, которую владелец применил и никто не поправил в Kaiten.
 */
export function freshSince(fm: Pick<Frontmatter, 'created' | 'revised' | 'assessment' | 'assessed'>): string {
  const revised = fm.revised ?? fm.created;
  const confirmed = fm.assessed?.verdict === 'actual' && assessedBy(fm) === 'script' ? fm.assessed.date : undefined;
  return confirmed !== undefined && confirmed > revised ? confirmed : revised;
}

/** Полных дней от `from` до `to` (обе — YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Что не так с текстом раздела, предложенным скриптом оценки: тот же разбор,
 * что у признака, но открытые продуктовые вопросы — честный ответ, а не
 * ошибка (с ними признак просто «Нет»).
 */
export function proposedSectionProblems(name: string, text: string): string[] {
  const section = JUNIOR_SECTIONS.find((s) => s.name === name);
  if (!section) return [`нет такого раздела «${name}»`];
  return sectionProblems(section, text).filter((p) => p !== openQuestions(section));
}

/** Разделы, которые признак не засчитывает (нет, пустой, не хватает пунктов), — их предлагает скрипт оценки. */
export function incompleteSections(body: string): string[] {
  return JUNIOR_SECTIONS.filter((s) => sectionProblems(s, sectionText(body, s.name)).some((p) => p !== openQuestions(s))).map((s) => s.name);
}

/** Раздел начинается с «Нет» — явное утверждение, что изменений нет. */
export function saysNo(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  return first !== undefined && NO_RE.test(plain(first));
}

/**
 * Тело с текстами разделов: раздел, который есть, заменяется целиком (до
 * следующего заголовка того же или более высокого уровня), которого нет —
 * встаёт перед критериями в порядке `JUNIOR_SECTIONS`, как в каркасе.
 */
export function withJuniorSections(type: TaskType, body: string, texts: Readonly<Record<string, string>>): string {
  let out = body;
  const absent: string[] = [];
  for (const section of JUNIOR_SECTIONS) {
    const text = texts[section.name];
    if (text === undefined) continue;
    const block = [`## ${section.name}`, '', text.trim(), ''];
    const replaced = replaceSection(out, section.name, block);
    if (replaced === null) absent.push(...block);
    else out = replaced;
  }
  if (absent.length === 0) return out;
  const lines = out.replace(/\s+$/, '').split('\n');
  const { criteria } = SKELETONS[type];
  const at = criteria ? lines.findIndex((line) => line.replace(/[ \t]+$/, '') === `## ${criteria}`) : -1;
  if (at === -1) return [...lines, '', ...absent].join('\n');
  return [...lines.slice(0, at), ...absent, ...lines.slice(at)].join('\n') + '\n';
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** Раздел `## name` (со строкой заголовка) заменить строками `block`; `null` — раздела нет. */
function replaceSection(body: string, name: string, block: readonly string[]): string | null {
  const lines = body.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= 2) {
      end = i;
      break;
    }
    if (start < 0 && m[1].length === 2 && m[2].replace(/[*_`]/g, '').trim() === name) start = i;
  }
  if (start < 0) return null;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

/** Причины одной строкой — для поля «Младшему не хватает». */
export function juniorMissingText(missing: readonly string[]): string {
  return missing.join('; ');
}

/**
 * Три раздела с заготовками `<…>` — для тела `kaiten new`. Заготовку, которую
 * не заменили и не удалили, команда не пропустит; пустой раздел — можно.
 * Пункты — списком: строки подряд описание Kaiten склеило бы в абзац.
 */
export function juniorTemplate(): string {
  return JUNIOR_SECTIONS.map((s) =>
    [`## ${s.name}`, '', `<${s.intro}; иначе — пункты ниже; не знаете — удалите всё под заголовком>`, ...s.labels.map((label, i) => `- **${label}:** <${s.hints[i]}>`)].join('\n'),
  ).join('\n\n');
}

/** Тело с разделами перед критериями (story, tech, bug); у других типов — как есть. */
export function withJuniorTemplate(type: TaskType, body: string): string {
  if (!JUNIOR_TYPES.includes(type)) return body;
  const { criteria } = SKELETONS[type];
  const at = criteria ? body.search(new RegExp(`^## ${criteria}[ \\t]*$`, 'm')) : -1;
  if (at === -1) return `${body.trimEnd()}\n\n${juniorTemplate()}`;
  return `${body.slice(0, at)}${juniorTemplate()}\n\n${body.slice(at)}`;
}

// «Нет», «нет.», «**Нет** — только чтение», «- нет»; не «Нетривиально».
const NO_RE = /^нет(?![\p{L}\p{N}_])/iu;
const LABEL_RE = /^\s*(?:[-*+]\s+)?\*\*([^*]+?)\*\*\s*(.*)$/;
const PLACEHOLDER_RE = /^<[^>]*>$/;

function plain(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim();
}

function sectionProblems(section: JuniorSection, text: string | null): string[] {
  if (text === null) return [`${section.short}: нет раздела`];
  if (!filledText(text)) return [`${section.short}: раздел не заполнен`];
  const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (NO_RE.test(plain(lines[0]))) return [];

  const values = labelValues(section.labels, lines);
  const absent = section.labels.filter((label) => !values.has(label));
  const problems: string[] = [];
  if (absent.length === 1) problems.push(`${section.short}: нет пункта «${absent[0]}»`);
  else if (absent.length > 1) problems.push(`${section.short}: нет пунктов ${absent.map((l) => `«${l}»`).join(', ')}`);
  const answer = values.get(MUST_BE_NO);
  if (section.labels.includes(MUST_BE_NO) && answer !== undefined && !NO_RE.test(answer)) problems.push(openQuestions(section));
  return problems;
}

function openQuestions(section: JuniorSection): string {
  return `${section.short}: есть открытые вопросы`;
}

/**
 * Заполненные пункты раздела: метка → текст. Текст пункта — остаток строки с
 * меткой и строки до следующей известной метки; жирное, не совпавшее с
 * меткой, — часть текста. Пустой пункт и заготовка `<…>` не засчитываются.
 */
function labelValues(labels: readonly string[], lines: readonly string[]): Map<string, string> {
  const known = new Map(labels.map((label) => [norm(label), label]));
  const collected = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const m = LABEL_RE.exec(line);
    const label = m ? known.get(norm(m[1].replace(/:\s*$/, ''))) : undefined;
    if (m && label !== undefined) {
      current = [m[2].replace(/^:\s*/, '')];
      if (!collected.has(label)) collected.set(label, current);
      continue;
    }
    current?.push(line);
  }
  const values = new Map<string, string>();
  for (const [label, parts] of collected) {
    const text = parts.map(plain).filter((p) => p !== '' && !PLACEHOLDER_RE.test(p)).join(' ');
    if (text !== '') values.set(label, text);
  }
  return values;
}

function norm(label: string): string {
  return label.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}
