/**
 * Страница документа глазами сервера: шапка, разделы, история изменений.
 *
 * Шапку и «Историю изменений» ведёт только сервер. Агент пишет лишь
 * содержимое разделов (markdown без `#`/`##`), поэтому подделать статус,
 * владельца или запись истории он не может: шапка — это абзацы в самом
 * начале страницы, до первого раздела, а туда агентский текст не попадает.
 */

import { z } from 'zod';

import { normalizeTitle } from './board-rules.js';
import { BlocksRulesSchema } from './doc-blocks.js';
import { heading, inline, type PMNode, plainText } from './prosemirror.js';

export const HISTORY = 'История изменений';
export const STATUSES = ['Черновик', 'Действует', 'Устарел'] as const;
export type Status = (typeof STATUSES)[number];

export interface DocLink {
  title: string;
  url: string;
}

export interface Header {
  owner: string;
  status: Status;
  links: DocLink[];
  updated: string;
}

export interface Section {
  title: string;
  nodes: PMNode[];
}

export interface Page {
  header: Header | null;
  /** Узлы между шапкой и первым разделом — возвращаются как есть. */
  preamble: PMNode[];
  sections: Section[];
}

const LABELS = ['Владелец', 'Статус', 'Связано с', 'Обновлено'] as const;

/** Абзац шапки: `**Метка:** значение`. */
function headerLabel(node: PMNode): string | null {
  if (node.type !== 'paragraph') return null;
  const first = node.content?.[0];
  if (!first || first.type !== 'text' || !first.marks?.some((m) => m.type === 'strong')) return null;
  const label = (first.text ?? '').trim().replace(/:$/, '');
  return (LABELS as readonly string[]).includes(label) ? label : null;
}

const valueText = (node: PMNode): string => plainText(node.content?.slice(1));

function headingLevel(node: PMNode): number | null {
  if (node.type === 'heading') return Number(node.attrs?.level ?? 0);
  if (/^heading[1-6]$/.test(node.type)) return Number(node.type.slice(-1));
  return null;
}

export function parsePage(nodes: PMNode[]): Page {
  let i = 0;
  const found: Record<string, PMNode> = {};
  for (; i < nodes.length; i++) {
    const label = headerLabel(nodes[i]);
    if (!label) break;
    found[label] = nodes[i];
  }
  let header: Header | null = null;
  if (LABELS.every((l) => found[l])) {
    const status = valueText(found['Статус']) as Status;
    const links: DocLink[] = [];
    for (const n of found['Связано с'].content ?? []) {
      const link = n.marks?.find((m) => m.type === 'link');
      if (link) links.push({ title: n.text ?? '', url: String(link.attrs?.href ?? '') });
    }
    header = {
      owner: valueText(found['Владелец']),
      status: (STATUSES as readonly string[]).includes(status) ? status : 'Черновик',
      links,
      updated: valueText(found['Обновлено']),
    };
  } else {
    i = 0;
  }
  const preamble: PMNode[] = [];
  const sections: Section[] = [];
  for (; i < nodes.length; i++) {
    const node = nodes[i];
    if (headingLevel(node) === 2) sections.push({ title: plainText(node.content), nodes: [] });
    else if (sections.length) sections[sections.length - 1].nodes.push(node);
    else preamble.push(node);
  }
  return { header, preamble, sections };
}

function labelParagraph(label: string, value: PMNode[]): PMNode {
  return { type: 'paragraph', content: [{ type: 'text', text: `${label}:`, marks: [{ type: 'strong' }] }, { type: 'text', text: ' ' }, ...value] };
}

export function renderHeader(header: Header): PMNode[] {
  const links: PMNode[] = [];
  header.links.forEach((link, i) => {
    if (i > 0) links.push({ type: 'text', text: ', ' });
    links.push({ type: 'text', text: link.title, marks: [{ type: 'link', attrs: { href: link.url } }] });
  });
  return [
    labelParagraph('Владелец', inline(header.owner)),
    labelParagraph('Статус', [{ type: 'text', text: header.status }]),
    labelParagraph('Связано с', links.length ? links : [{ type: 'text', text: '—' }]),
    labelParagraph('Обновлено', [{ type: 'text', text: header.updated }]),
  ];
}

export function renderPage(page: Page): PMNode[] {
  const out: PMNode[] = [...(page.header ? renderHeader(page.header) : []), ...page.preamble];
  for (const section of page.sections) out.push(heading(2, section.title), ...section.nodes);
  return out;
}

export const findSection = (page: Page, title: string): Section | undefined =>
  page.sections.find((s) => normalizeTitle(s.title) === normalizeTitle(title));

/** Записать строку истории: раздел «История изменений» всегда последний. */
export function addHistory(page: Page, line: string): void {
  let history = findSection(page, HISTORY);
  if (history) page.sections = [...page.sections.filter((s) => s !== history), history];
  else {
    history = { title: HISTORY, nodes: [] };
    page.sections.push(history);
  }
  let list = history.nodes.find((n) => n.type === 'bullet_list');
  if (!list) {
    list = { type: 'bullet_list', content: [] };
    history.nodes.push(list);
  }
  list.content = [...(list.content ?? []), { type: 'list_item', content: [{ type: 'paragraph', content: inline(line) }] }];
}

// ── правила папки ───────────────────────────────────────────────────────────

export const RULES_TITLE = '⚙ Правила для агента';

/** Служебная страница правил — под любым написанием. */
export function isRulesTitle(title: string): boolean {
  return normalizeTitle(title.replace(/^[\s⚙️]+/u, '')) === normalizeTitle('Правила для агента');
}

const Level = z.enum(['free', 'confirm']);

export const FolderRulesSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1),
    sections: z.array(z.string().min(1)).default([]),
    link: z.union([z.string().min(1), z.array(z.string().min(1))]).default('none'),
    levels: z
      .object({ append: Level.default('free'), replace: Level.default('confirm'), locked_when_active: z.boolean().default(false) })
      .strict()
      .default({ append: 'free', replace: 'confirm', locked_when_active: false }),
    /** Встроенные блоки, видео и картинки; нет ключа — нельзя (doc-blocks.ts). */
    blocks: BlocksRulesSchema.optional(),
  })
  .strict();
export type FolderRules = z.infer<typeof FolderRulesSchema>;

/** Типы карточек, с которыми страница обязана быть связана; пусто — связь не обязательна. */
export function linkTypes(rules: FolderRules): string[] {
  const list = Array.isArray(rules.link) ? rules.link : [rules.link];
  return list.filter((t) => t !== 'none');
}
