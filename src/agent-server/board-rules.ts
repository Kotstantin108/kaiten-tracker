/**
 * Правила доски для агента — из описания доски в Kaiten.
 *
 * Описание — инструкция для агента и источник правил одновременно: текстовые
 * разделы «Доска», «Этапы», «Дорожки», «Поля» и строгий блок YAML в разделе
 * «Правила». В YAML — только то, чего не выражает сам Kaiten: шаблон названия,
 * обязательный родитель, дорожка, запрет дублей, колонки создания, признак
 * доски, которую ведёт git.
 *
 * Закрыто по умолчанию: нет описания, нет блока правил, блок не разбирается
 * или не описаны все колонки и обязательные поля — доска закрыта для записи
 * агентом, и причина видна в отказе.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const TypeRuleSchema = z
  .object({
    title: z.string().min(1, 'шаблон названия пуст'),
    lane: z.string().min(1).default('default'),
    parent: z.string().min(1).default('none'),
  })
  .strict();
export type TypeRule = z.infer<typeof TypeRuleSchema>;

const BoardRulesSchema = z
  .object({
    version: z.literal(1),
    duplicates: z.enum(['board', 'space', 'off']).default('board'),
    /** Сузить колонки создания (из колонок-очередей). */
    columns: z.array(z.string().min(1)).optional(),
    /** Карточки с external_id ведёт git: агент их только комментирует. */
    synced: z.boolean().default(false),
    /** Тип → правило; `"*"` — любой тип доски. */
    types: z.record(z.string().min(1), TypeRuleSchema).refine((t) => Object.keys(t).length > 0, 'не задано ни одного типа'),
  })
  .strict();
export type BoardRules = z.infer<typeof BoardRulesSchema>;

export interface ParsedDescription {
  rules: BoardRules;
  /** Текст разделов по заголовку `## …` (без заголовка). */
  sections: Record<string, string>;
}

export type ParseResult = { ok: true; value: ParsedDescription } | { ok: false; problems: string[] };

function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.replace(/\r\n/g, '\n').split(/^##[ \t]+(.+?)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i].trim()] = (parts[i + 1] ?? '').trim();
  return sections;
}

/** Разобрать описание доски. Проблемы — по-русски, их видит агент в отказе. */
export function parseBoardDescription(description: string | null | undefined): ParseResult {
  if (!description || !description.trim()) return { ok: false, problems: ['у доски нет описания для агентов'] };
  const sections = splitSections(description);
  const problems: string[] = [];
  for (const name of ['Доска', 'Этапы', 'Поля']) if (!(name in sections)) problems.push(`в описании нет раздела «${name}»`);
  const block = /```ya?ml[ \t]*\n([\s\S]*?)```/.exec(sections['Правила'] ?? '');
  if (!block) return { ok: false, problems: [...problems, 'в описании нет блока правил (раздел «Правила», блок ```yaml)'] };

  let raw: unknown;
  try {
    raw = parseYaml(block[1]);
  } catch (error) {
    return { ok: false, problems: [...problems, `блок правил не разбирается как YAML: ${(error as Error).message.split('\n')[0]}`] };
  }
  const parsed = BoardRulesSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`блок правил: ${issue.path.join('.') || 'корень'} — ${issue.message}`);
  }
  if (problems.length > 0 || !parsed.success) return { ok: false, problems };
  return { ok: true, value: { rules: parsed.data, sections } };
}

/** Есть ли в тексте раздела пункт про этот объект (`**Название**`). */
export function mentions(sectionText: string | undefined, name: string): boolean {
  if (!sectionText) return false;
  return sectionText.includes(`**${name}**`);
}

/**
 * Проверка полноты: каждая колонка описана в «Этапах», каждое обязательное
 * или требуемое ограничением поле — в «Полях». Иначе агент получит отказ без
 * объяснения, что значит поле, — значит, доска не готова.
 */
export function coverageProblems(parsed: ParsedDescription, columns: string[], fields: string[]): string[] {
  const problems: string[] = [];
  for (const column of columns) if (!mentions(parsed.sections['Этапы'], column)) problems.push(`в «Этапах» не описана колонка «${column}»`);
  for (const field of fields) if (!mentions(parsed.sections['Поля'], field)) problems.push(`в «Полях» не описано поле «${field}»`);
  return problems;
}

/** Пояснение поля из раздела «Поля»: текст пункта после `**Поле** —`. */
export function fieldHint(parsed: ParsedDescription, field: string): string | null {
  const text = parsed.sections['Поля'];
  if (!text) return null;
  for (const line of text.split('\n')) {
    const at = line.indexOf(`**${field}**`);
    if (at < 0) continue;
    const hint = line.slice(at + field.length + 4).replace(/^\s*[—–-]\s*/, '').trim();
    return hint || null;
  }
  return null;
}

/** Правило для типа: точное имя или `"*"`. */
export function typeRule(rules: BoardRules, typeName: string): TypeRule | null {
  return rules.types[typeName] ?? rules.types['*'] ?? null;
}

// ── шаблон названия ─────────────────────────────────────────────────────────

export interface TitleTemplate {
  template: string;
  parts: string[];
  regex: RegExp;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileTitle(template: string): TitleTemplate {
  const parts: string[] = [];
  let pattern = '';
  let last = 0;
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    pattern += escapeRegex(template.slice(last, match.index));
    pattern += '(.+?)';
    parts.push(match[1].trim());
    last = (match.index ?? 0) + match[0].length;
  }
  pattern += escapeRegex(template.slice(last));
  return { template, parts, regex: new RegExp(`^${pattern}$`, 'u') };
}

/** Проверить название по шаблону; строка — что не так. */
export function titleProblem(template: string, title: string): string | null {
  const compiled = compileTitle(template);
  const match = compiled.regex.exec(title.trim());
  if (!match) return `название должно быть по шаблону «${template}»`;
  const empty = compiled.parts.filter((_, i) => !match[i + 1]?.trim());
  return empty.length > 0 ? `в названии пустые части: ${empty.join(', ')} (шаблон «${template}»)` : null;
}

// ── дубли ────────────────────────────────────────────────────────────────────

/** Нормализация названия для поиска дублей: регистр, ё/е, кавычки, пробелы. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["'«»„“”‘’`]/g, '')
    .replace(/[\s ]+/g, ' ')
    .trim();
}
