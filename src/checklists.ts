/**
 * Пункты `- [ ]` / `- [x]` из тела задачи → чек-листы Kaiten.
 *
 * ЗАЧЕМ. Живьём 23.09.2026: markdown-описание Kaiten не отображает чекбоксы
 * задач (а их в задачах около пяти тысяч), и редактор интерфейса при правке
 * экранирует их в `\[ \]`. Владелец выбрал нативные чек-листы: пункты
 * переезжают туда, по чек-листу на раздел (ближайший заголовок сверху —
 * «Критерии готовности», «Шаги (HOW)»…), а в описании на месте пунктов
 * остаётся ссылка на чек-лист.
 *
 * ВЛАДЕНИЕ. Чек-листы создаются один раз — при создании карточки или когда
 * у карточки нет чек-листа с таким именем — и дальше не перезаписываются:
 * отметки ставят в Kaiten. Как отметки возвращаются в файл, решается в цикле
 * сверки (story `tracker-sync-worker`), здесь — только первичный перенос.
 */

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

export interface Checklist {
  name: string;
  items: ChecklistItem[];
}

export interface ExtractResult {
  /** Тело без пунктов: на месте каждого блока — строка-ссылка на чек-лист. */
  body: string;
  checklists: Checklist[];
}

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]*(.*)$/;
const LIST_START_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const DEFAULT_NAME = 'Чек-лист';

/**
 * Префикс чек-листов из файла (решение владельца 25.09.2026, раздельные
 * чек-листы). «Агент · …» — пункты задачи из репозитория: их отмечает агент
 * в файле, Kaiten только показывает. Чек-листы без префикса заводят и
 * отмечают люди в Kaiten, импорт их не трогает. У каждого чек-листа один
 * владелец — Q1 без исключений.
 */
export const AGENT_PREFIX = 'Агент · ';

export function withoutAgentPrefix(name: string): string {
  return name.startsWith(AGENT_PREFIX) ? name.slice(AGENT_PREFIX.length) : name;
}

/** Заголовок без markdown-украшений: `**Шаги** (HOW)` → `Агент · Шаги (HOW)`. */
function headingName(raw: string): string {
  return AGENT_PREFIX + (raw.replace(/[*_`]/g, '').trim() || DEFAULT_NAME);
}

export function extractChecklists(markdown: string): ExtractResult {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const byName = new Map<string, Checklist>();
  let heading = AGENT_PREFIX + DEFAULT_NAME;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence || FENCE_RE.test(line)) {
      out.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) heading = headingName(h[1]);

    if (!ITEM_RE.test(line)) {
      out.push(line);
      continue;
    }

    // Блок подряд идущих пунктов; строки-продолжения (перенос длинного пункта
    // с отступом) приклеиваются к своему пункту.
    const list = byName.get(heading) ?? { name: heading, items: [] };
    byName.set(heading, list);
    while (i < lines.length) {
      const m = ITEM_RE.exec(lines[i]);
      if (!m) break;
      const indent = m[1].length;
      const parts = [m[3].trim()];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== '' &&
        !LIST_START_RE.test(lines[i + 1]) &&
        !HEADING_RE.test(lines[i + 1]) &&
        (lines[i + 1].length - lines[i + 1].trimStart().length) > indent
      ) {
        parts.push(lines[++i].trim());
      }
      list.items.push({ text: parts.join(' ').trim() || '—', checked: m[2] !== ' ' });
      i++;
    }
    i--;
    out.push(`_Пункты — в чек-листе «${heading}» карточки._`);
  }

  return { body: out.join('\n'), checklists: [...byName.values()] };
}
