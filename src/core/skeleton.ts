/**
 * Скелет тела задачи по типу (решение 10) и раздел критериев, который линтер
 * требует непустым.
 *
 * У спайка раздела критериев нет: его результат — ответ на вопрос, а не
 * отмеченные пункты. Поэтому для спайка линтер требует непустой «Ответ» при
 * закрытии (`done`), а не критерии при создании. Подтверждено владельцем
 * 25.09.2026. Линтер отмечает пустой «Ответ» у закрытого спайка только
 * предупреждением: он не отличает закрытие сейчас от архива до v2. Ошибкой
 * это должна делать команда, которая закрывает задачу.
 */

import type { TaskType } from './schema.js';

interface Skeleton {
  sections: readonly string[];
  /** Раздел, где обязателен хотя бы один пункт `- [ ]`; `null` — нет такого. */
  criteria: string | null;
}

export const SKELETONS: Record<TaskType, Skeleton> = {
  story: { sections: ['Зачем', 'Что сделать', 'Критерии готовности', 'Шаги'], criteria: 'Критерии готовности' },
  tech: { sections: ['Зачем', 'Что сделать', 'Критерии готовности', 'Шаги'], criteria: 'Критерии готовности' },
  bug: { sections: ['Что происходит', 'Как воспроизвести', 'Как должно быть', 'Критерии'], criteria: 'Критерии' },
  epic: { sections: ['Цель', 'Критерии-результаты'], criteria: 'Критерии-результаты' },
  spike: { sections: ['Вопрос', 'Как ищем ответ', 'Ответ'], criteria: null },
};

export const SPIKE_ANSWER_SECTION = 'Ответ';

export function renderSkeleton(type: TaskType): string {
  const { sections, criteria } = SKELETONS[type];
  return sections.map((name) => `## ${name}\n\n${name === criteria ? '- [ ] \n' : ''}`).join('\n');
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Текст раздела `## <name>` до следующего заголовка того же или более
 * высокого уровня; `null`, если раздела нет. Заголовки внутри блоков кода не
 * считаются.
 */
export function sectionText(body: string, name: string | ((heading: string) => boolean)): string | null {
  const matches = typeof name === 'string' ? (heading: string) => heading === name : name;
  const lines = body.split('\n');
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
    if (start < 0 && matches(m[2].replace(/[*_`]/g, '').trim())) {
      start = i + 1;
      level = m[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

/**
 * Раздел критериев в том виде, как их писали до v2: «Критерии готовности
 * (эпик)», «Критерий приёмки»… Засчитывается любой заголовок на «Критери».
 * Заголовки при конвертации не переименовываются: по ним сопоставлены
 * чек-листы «Агент · …» живых карточек.
 */
export function criteriaText(body: string): string | null {
  return sectionText(body, (heading) => /^Критери/i.test(heading));
}

const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\][ \t]+\S/;

/** Число непустых пунктов-чекбоксов в тексте. */
export function countChecklistItems(text: string): number {
  return text.split('\n').filter((line) => ITEM_RE.test(line)).length;
}

/**
 * Подсказки под заголовками шаблона описания в Kaiten — для тех, кто заводит
 * задачу в интерфейсе (менеджеры, фаундер). Чекбоксов нет: описание Kaiten
 * их не отображает (проверено 23.09.2026), критерии — обычным списком.
 * «Суть» в шаблон не входит: это отдельное обязательное поле карточки.
 */
const SECTION_HINTS: Record<string, string> = {
  Зачем: 'Какую проблему решаем и для кого.',
  'Что сделать': 'Что должно появиться или измениться — на языке результата, не кода.',
  'Критерии готовности': '- По чему поймём, что сделано (проверяемо)',
  Шаги: '- Необязательно: план по шагам',
  'Что происходит': 'Что сломано и где. Кого задевает.',
  'Как воспроизвести': '1. Шаги, окружение, аккаунт',
  'Как должно быть': 'Ожидаемое поведение.',
  Критерии: '- По чему поймём, что исправлено',
  Цель: 'Какой результат для продукта или бизнеса даёт эпик.',
  'Критерии-результаты': '- Измеримый результат, а не список работ: работа — дочерние задачи',
  Вопрос: 'Что хотим выяснить и какое решение от ответа зависит.',
  'Как ищем ответ': 'Источники, эксперименты, сколько времени готовы потратить.',
  Ответ: 'Заполняется при закрытии.',
};

export function kaitenTemplate(type: TaskType): string {
  return `${SKELETONS[type].sections.map((name) => `## ${name}\n\n${SECTION_HINTS[name] ?? ''}\n`).join('\n')}`;
}

/**
 * Описание карточки без незаполненных подсказок шаблона: Kaiten подставляет
 * шаблон типа и в карточку, созданную без описания (живьём 29.09), а
 * подсказка, которую не стёрли, — не текст задачи. Подсказки любого типа:
 * тип карточки могли сменить после создания.
 */
export function stripTemplateHints(text: string): string {
  const hints = new Set(Object.values(SECTION_HINTS));
  const lines = text.split('\n').filter((line) => !hints.has(line.trim()));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** В тексте есть что-то кроме заголовков. */
export function hasContent(text: string): boolean {
  return text.split('\n').some((line) => line.trim() !== '' && !HEADING_RE.test(line));
}

// ── тело новой задачи ────────────────────────────────────────────────────
//
// `kaiten new` заводит задачу только с заполненной постановкой (владелец
// 01.10.2026): в испытании агенты заводили задачи с пустым скелетом, а
// подсказку линтера после создания не выполнял никто. Проверка — только у
// команды `new`: линтер, перенос карточек и правка старых задач её не
// требуют (у 78 перенесённых задач критериев нет).

/** Строка в разделе критериев: критериев у задачи нет намеренно, и сказано почему. */
export const NO_CRITERIA_PREFIX = 'Критериев нет:';

/** Разделы, которые у новой задачи должны быть заполнены; критерии — отдельно. «Шаги» и «Ответ» необязательны. */
const REQUIRED_SECTIONS: Record<TaskType, readonly string[]> = {
  story: ['Зачем', 'Что сделать'],
  tech: ['Зачем', 'Что сделать'],
  bug: ['Что происходит', 'Как воспроизвести', 'Как должно быть'],
  epic: ['Цель'],
  spike: ['Вопрос', 'Как ищем ответ'],
};

/** В тексте раздела есть пометка «Критериев нет: <причина>». */
export function hasCriteriaWaiver(text: string): boolean {
  return text.split('\n').some((line) => line.trim().startsWith(NO_CRITERIA_PREFIX) && line.trim().length > NO_CRITERIA_PREFIX.length);
}

/** Строка-заглушка шаблона `<…>`, в том числе после метки `**Откат:**`: её не заполнили. */
const PLACEHOLDER_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?(?:\*\*[^*]+\*\*\s*:?\s*)?<[^>]*>\s*$/;

/** В тексте есть строка кроме заголовков и заготовок `<…>`. */
export function filledText(text: string | null): boolean {
  if (text === null) return false;
  return text.split('\n').some((line) => line.trim() !== '' && !HEADING_RE.test(line) && !PLACEHOLDER_RE.test(line));
}

// ── «Как проверить» ──────────────────────────────────────────────────────
//
// План проверки в постановке story — только в проекте, который его просит
// (`review.testPlan` в kaiten.json, `docs/review-gates.md`): как и критерии,
// требуется у `kaiten new`, а не у линтера, — старые задачи без раздела
// остаются рабочими.

export const TEST_PLAN_SECTION = 'Как проверить';
export const TEST_PLAN_TYPES: readonly TaskType[] = ['story'];
/** Строка в разделе: проверять нечего, и сказано почему (`--no-test-plan`). */
export const NO_TEST_PLAN_PREFIX = 'Проверять нечего:';
const TEST_PLAN_HINT = '<какие интеграционные тесты добавить или изменить и как проверить результат как чёрный ящик, не читая код>';
/** Раздел, перед которым стоит «Как проверить». */
const TEST_PLAN_BEFORE = 'Шаги';

export function testPlanApplies(type: TaskType): boolean {
  return TEST_PLAN_TYPES.includes(type);
}

function headingIndex(lines: readonly string[], name: string): number {
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m !== null && m[2].replace(/[*_`]/g, '').trim() === name) return i;
  }
  return -1;
}

/** Текст с разделом, вставленным перед «Шаги» (их нет — в конец). */
function withSectionBeforeSteps(body: string, section: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  const at = headingIndex(lines, TEST_PLAN_BEFORE);
  if (at === -1) return `${lines.join('\n')}\n\n${section}`;
  return [...lines.slice(0, at), section, '', ...lines.slice(at)].join('\n');
}

/** Шаблон постановки с разделом «Как проверить» перед «Шаги» (story); у других типов — как есть. */
export function withTestPlanTemplate(type: TaskType, template: string): string {
  if (!testPlanApplies(type)) return template;
  return withSectionBeforeSteps(template, `## ${TEST_PLAN_SECTION}\n\n${TEST_PLAN_HINT}`);
}

/** Тело с пометкой «Проверять нечего: <причина>» в разделе «Как проверить» (раздела нет — перед «Шаги»). */
export function withTestPlanWaiver(type: TaskType, body: string, reason: string): string {
  if (!testPlanApplies(type)) return body;
  const line = `${NO_TEST_PLAN_PREFIX} ${reason.trim()}`;
  const lines = body.replace(/\s+$/, '').split('\n');
  const at = headingIndex(lines, TEST_PLAN_SECTION);
  if (at === -1) return `${withSectionBeforeSteps(body, `## ${TEST_PLAN_SECTION}\n\n${line}`)}\n`;
  return `${[...lines.slice(0, at + 1), '', line, ...lines.slice(at + 1)].join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export interface NewBodyOptions {
  /** Проект просит раздел «Как проверить» у story. */
  testPlan?: boolean;
}

/** Что не так с телом новой задачи — словами для того, кто её заводит; пусто — можно заводить. */
export function newBodyProblems(type: TaskType, body: string, options: NewBodyOptions = {}): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_SECTIONS[type]) {
    const text = sectionText(body, name);
    if (text === null) problems.push(`нет раздела «${name}»`);
    else if (!filledText(text)) problems.push(`раздел «${name}» не заполнен`);
  }
  if (body.split('\n').some((line) => PLACEHOLDER_RE.test(line))) problems.push('остались заготовки шаблона <…> — замените их текстом или удалите');
  const { criteria } = SKELETONS[type];
  if (criteria) {
    const text = sectionText(body, criteria) ?? criteriaText(body);
    if (text === null) problems.push(`нет раздела «${criteria}»`);
    else if (countChecklistItems(text) === 0 && !hasCriteriaWaiver(text)) {
      problems.push(`в разделе «${criteria}» нет ни одного пункта \`- [ ]\` — напишите, по чему поймём, что сделано, или --no-criteria "<почему критериев нет>"`);
    }
  }
  if (options.testPlan && testPlanApplies(type)) {
    const text = sectionText(body, TEST_PLAN_SECTION);
    const how = 'какие интеграционные тесты добавить или изменить и как проверить результат как чёрный ящик, не читая код; проверять нечего — --no-test-plan "<почему>"';
    if (text === null) problems.push(`нет раздела «${TEST_PLAN_SECTION}» — ${how}`);
    else if (!filledText(text)) problems.push(`раздел «${TEST_PLAN_SECTION}» не заполнен — ${how}`);
  }
  return problems;
}

/** Тело с пометкой «Критериев нет: <причина>» в разделе критериев (раздела нет — добавляется в конец). */
export function withCriteriaWaiver(type: TaskType, body: string, reason: string): string {
  const { criteria } = SKELETONS[type];
  if (!criteria) return body;
  const line = `${NO_CRITERIA_PREFIX} ${reason.trim()}`;
  const lines = body.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => {
    const m = HEADING_RE.exec(l);
    return m !== null && /^Критери/i.test(m[2].replace(/[*_`]/g, '').trim());
  });
  if (at === -1) return `${lines.join('\n')}\n\n## ${criteria}\n\n${line}\n`;
  return `${[...lines.slice(0, at + 1), '', line, ...lines.slice(at + 1)].join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** Заготовки для шаблона в помощи и отказе `kaiten new`: что писать в разделе. */
const NEW_HINTS: Record<string, string> = {
  Зачем: '<какую проблему решаем и для кого>',
  'Что сделать': '<что должно появиться или измениться>',
  'Критерии готовности': '- [ ] <по чему поймём, что сделано — проверяемо>',
  Шаги: '- [ ] <необязательно: план по шагам>',
  'Что происходит': '<что сломано и где, кого задевает>',
  'Как воспроизвести': '1. <шаги, данные, окружение>',
  'Как должно быть': '<ожидаемое поведение>',
  Критерии: '- [ ] <по чему поймём, что исправлено>',
  Цель: '<какой результат для продукта даёт эпик>',
  'Критерии-результаты': '- [ ] <измеримый результат; работа — дочерние задачи>',
  Вопрос: '<что выясняем и какое решение от ответа зависит>',
  'Как ищем ответ': '<источники, эксперименты, сколько времени готовы потратить>',
};

/** Тело-шаблон для `kaiten new --stdin`: разделы типа с заготовками `<…>`; «Ответ» спайка заполняется при закрытии. */
export function newBodyTemplate(type: TaskType): string {
  return SKELETONS[type].sections
    .filter((name) => NEW_HINTS[name])
    .map((name) => `## ${name}\n\n${NEW_HINTS[name]}`)
    .join('\n\n');
}
