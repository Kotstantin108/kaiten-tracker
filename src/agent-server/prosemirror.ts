/**
 * Текст документов Kaiten: ProseMirror JSON ⇄ простой markdown.
 *
 * Агент пишет markdown, сервер переводит его в узлы схемы v1 — той, что
 * принимает API для документов, созданных через API (проверено живьём):
 * абзацы, заголовки, списки, код, цитаты, линия, таблицы; отметки — жирный,
 * курсив, код, ссылка; блоки — встроенная страница и картинка (doc-blocks.ts).
 * Обратно в markdown переводится всё, что можно показать; узлы, которых
 * markdown не передаёт (чек-листы, вкладки…), дают пометку «с потерями» —
 * такой раздел агенту заменять нельзя, только дописывать. Блоки — «с
 * потерями», пока правила папки их не разрешают.
 *
 * Правка всегда идёт на уровне узлов: разделы, которые агент не трогал,
 * возвращаются в Kaiten ровно такими, какими пришли.
 */

import { z } from 'zod';

import { blockFromLine, blockKind, type BlockKind, blockMarkdown } from './doc-blocks.js';

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}

const MarkSchema: z.ZodType<PMMark> = z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() }).passthrough();
export const NodeSchema: z.ZodType<PMNode> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      attrs: z.record(z.string(), z.unknown()).optional(),
      content: z.array(NodeSchema).optional(),
      text: z.string().optional(),
      marks: z.array(MarkSchema).optional(),
    })
    .passthrough(),
);

/** Содержимое документа из ответа Kaiten (`data` приходит строкой с JSON). */
export function parseDocData(data: unknown): PMNode[] {
  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const parsed = NodeSchema.safeParse(raw);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

export const docOf = (content: PMNode[]): PMNode => ({ type: 'doc', content });

// ── markdown → узлы ─────────────────────────────────────────────────────────

const text = (value: string, marks?: PMMark[]): PMNode => ({ type: 'text', text: value, ...(marks?.length ? { marks } : {}) });

export function inline(source: string): PMNode[] {
  const out: PMNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push(text(source.slice(last, m.index)));
    if (m[1] !== undefined) out.push(text(m[1], [{ type: 'strong' }]));
    else if (m[2] !== undefined) out.push(text(m[2], [{ type: 'code' }]));
    else if (m[3] !== undefined) out.push(text(m[3], [{ type: 'link', attrs: { href: m[4] } }]));
    else if (m[5] !== undefined) out.push(text(m[5], [{ type: 'em' }]));
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < source.length) out.push(text(source.slice(last)));
  return out.filter((n) => n.text !== '');
}

export const paragraph = (source: string): PMNode => {
  const content = inline(source);
  return { type: 'paragraph', ...(content.length ? { content } : {}) };
};

export const heading = (level: number, source: string): PMNode => ({ type: 'heading', attrs: { level }, content: inline(source) });

const listItem = (source: string): PMNode => ({ type: 'list_item', content: [paragraph(source)] });

function tableRow(line: string, header: boolean): PMNode {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return { type: 'table_row', content: cells.map((cell) => ({ type: header ? 'table_header' : 'table_cell', content: [paragraph(cell.trim())] })) };
}

export interface Converted {
  nodes: PMNode[];
  problems: string[];
}

/**
 * Markdown агента → узлы v1. Заголовки `#` и `##` внутри раздела запрещены:
 * `##` — граница разделов, и агент не должен создавать разделы мимо правил.
 */
export function markdownToNodes(markdown: string): Converted {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const nodes: PMNode[] = [];
  const problems: string[] = [];
  let para: string[] = [];
  let list: { type: 'bullet_list' | 'ordered_list'; items: PMNode[] } | null = null;
  const flushPara = (): void => {
    if (para.length) nodes.push(paragraph(para.join(' ')));
    para = [];
  };
  const flushList = (): void => {
    if (list) nodes.push({ type: list.type, content: list.items });
    list = null;
  };
  const flush = (): void => {
    flushPara();
    flushList();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const language = line.slice(3).trim();
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      nodes.push({ type: 'code_block', attrs: { language: language || null }, ...(body.length ? { content: [text(body.join('\n'))] } : {}) });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      if (h[1].length <= 2) problems.push(`заголовок «${h[2]}»: внутри раздела можно только ### и мельче — ## отделяет разделы`);
      else nodes.push(heading(h[1].length, h[2]));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const rows = [tableRow(line, true)];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(tableRow(lines[i], false));
      i--;
      nodes.push({ type: 'table', content: rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushPara();
      const type = bullet ? 'bullet_list' : 'ordered_list';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push(listItem((bullet ?? ordered)?.[1] ?? ''));
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      nodes.push({ type: 'horizontal_rule' });
      continue;
    }
    const block = blockFromLine(line);
    if (block) {
      flush();
      nodes.push(block);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      nodes.push({ type: 'blockquote', content: [paragraph(quote[1])] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flush();
  return { nodes, problems };
}

// ── узлы → markdown ─────────────────────────────────────────────────────────

export interface Rendered {
  markdown: string;
  /** Есть узлы, которых markdown не передаёт: заменять такой раздел нельзя. */
  lossy: boolean;
}

function inlineMd(nodes: PMNode[] | undefined): string {
  return (nodes ?? [])
    .map((n) => {
      if (n.type === 'hard_break') return ' ';
      if (n.type !== 'text') return n.content ? inlineMd(n.content) : '';
      let value = n.text ?? '';
      for (const mark of n.marks ?? []) {
        if (mark.type === 'strong') value = `**${value}**`;
        else if (mark.type === 'em') value = `*${value}*`;
        else if (mark.type === 'code') value = `\`${value}\``;
        else if (mark.type === 'link') value = `[${value}](${String(mark.attrs?.href ?? '')})`;
      }
      return value;
    })
    .join('');
}

/** Простой текст узлов — для проверки «раздел не пустой» и поиска дублей. */
export function plainText(nodes: PMNode[] | undefined): string {
  return (nodes ?? []).map((n) => (n.type === 'text' ? (n.text ?? '') : plainText(n.content))).join(' ').replace(/\s+/g, ' ').trim();
}

/** Есть ли в узлах содержимое: текст или блок (раздел из одного графика — не пустой). */
export function hasContent(nodes: PMNode[] | undefined): boolean {
  return plainText(nodes) !== '' || (nodes ?? []).some((n) => blockKind(n) !== null || hasContent(n.content));
}

const SIMPLE = new Set(['paragraph', 'heading', 'heading1', 'heading2', 'heading3', 'bullet_list', 'ordered_list', 'code_block', 'blockquote', 'horizontal_rule', 'table']);

export interface RenderOptions {
  /** Блоки, которые разрешены правилами папки: только они не «с потерями». */
  blocks?: ReadonlySet<BlockKind>;
  /** Ссылки блоков — только доменом: для подтверждений и всего, что видят не агенту. */
  redact?: boolean;
}

export function nodesToMarkdown(nodes: PMNode[], options: RenderOptions = {}): Rendered {
  let lossy = false;
  const blocks: string[] = [];
  const cellText = (cell: PMNode): string => (cell.content ?? []).map((p) => inlineMd(p.content)).join(' ').replace(/\|/g, '\\|');
  for (const node of nodes) {
    const kind = blockKind(node);
    if (kind) {
      blocks.push(blockMarkdown(node, options.redact === true) ?? '');
      if (!options.blocks?.has(kind)) lossy = true;
      continue;
    }
    if (!SIMPLE.has(node.type)) lossy = true;
    switch (node.type) {
      case 'paragraph':
        blocks.push(inlineMd(node.content));
        break;
      case 'heading':
      case 'heading1':
      case 'heading2':
      case 'heading3': {
        const level = node.type === 'heading' ? Number(node.attrs?.level ?? 3) : Number(node.type.slice(-1));
        blocks.push(`${'#'.repeat(level)} ${inlineMd(node.content)}`);
        break;
      }
      case 'bullet_list':
      case 'ordered_list':
        blocks.push(
          (node.content ?? [])
            .map((item, i) => {
              const nested = (item.content ?? []).slice(1);
              if (nested.length) lossy = true;
              return `${node.type === 'bullet_list' ? '-' : `${i + 1}.`} ${inlineMd(item.content?.[0]?.content)}`;
            })
            .join('\n'),
        );
        break;
      case 'check_list':
        blocks.push((node.content ?? []).map((item) => `- [${item.attrs?.checked ? 'x' : ' '}] ${plainText(item.content)}`).join('\n'));
        break;
      case 'code_block':
        blocks.push(`\`\`\`${String(node.attrs?.language ?? '')}\n${plainText(node.content) === '' ? '' : (node.content ?? []).map((n) => n.text ?? '').join('')}\n\`\`\``);
        break;
      case 'blockquote':
        blocks.push((node.content ?? []).map((p) => `> ${inlineMd(p.content)}`).join('\n'));
        break;
      case 'horizontal_rule':
        blocks.push('---');
        break;
      case 'table': {
        const rows = (node.content ?? []).map((row) => `| ${(row.content ?? []).map(cellText).join(' | ')} |`);
        if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat((node.content?.[0]?.content ?? []).length)}`);
        blocks.push(rows.join('\n'));
        break;
      }
      default: {
        const inner = plainText(node.content);
        blocks.push(`[элемент «${node.type}»${inner ? `: ${inner}` : ''}]`);
      }
    }
  }
  return { markdown: blocks.join('\n\n'), lossy };
}
