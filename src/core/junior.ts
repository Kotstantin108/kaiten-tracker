/**
 * Признак «Можно младшему» (docs/junior-readiness.md): задачу можно брать
 * младшему разработчику, если она свежая, а продуктовые решения, изменения
 * в БД и сценарии n8n в ней либо явно отсутствуют («Нет»), либо описаны
 * всеми пунктами. Вычисляется из файла задачи механически, без сети.
 *
 * Разделы необязательны: нет раздела или пункта — не отказ, а «Нет» с
 * причиной, которую видит команда в поле карточки.
 */

import type { Frontmatter, TaskStatus, TaskType } from './schema.js';
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
/** Задачи, которые ещё можно взять; у остальных признака нет. */
export const JUNIOR_STATUSES: readonly TaskStatus[] = ['inbox', 'backlog', 'ready'];

/** `null` — признак к задаче не применим (тип или статус); иначе — годится ли и чего не хватает. */
export type JuniorReadiness = { ok: boolean; missing: string[] } | null;

export interface JuniorOptions {
  /** Сегодня, YYYY-MM-DD. */
  today: string;
  maxAgeDays: number;
}

export function juniorReadiness(fm: Pick<Frontmatter, 'type' | 'status' | 'updated'>, body: string, opts: JuniorOptions): JuniorReadiness {
  if (!JUNIOR_TYPES.includes(fm.type) || !JUNIOR_STATUSES.includes(fm.status)) return null;
  const missing: string[] = [];
  if (daysBetween(fm.updated, opts.today) > opts.maxAgeDays) missing.push(`задача старше ${opts.maxAgeDays} дней`);
  for (const section of JUNIOR_SECTIONS) missing.push(...sectionProblems(section, sectionText(body, section.name)));
  return { ok: missing.length === 0, missing };
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
  if (section.labels.includes(MUST_BE_NO) && answer !== undefined && !NO_RE.test(answer)) {
    problems.push(`${section.short}: есть открытые вопросы`);
  }
  return problems;
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

/** Полных дней от `from` до `to` (обе — YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
