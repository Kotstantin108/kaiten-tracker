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
