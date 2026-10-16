/**
 * Правила доски для агента — из описания доски в Kaiten.
 *
 * Описание — инструкция для агента и источник правил одновременно: текстовые
 * разделы «Доска», «Этапы», «Дорожки», «Поля» и строгий блок YAML в разделе
 * «Правила». В YAML — только то, чего не выражает сам Kaiten: шаблон названия,
 * обязательный родитель, дорожка, запрет дублей, колонки создания, признак
 * доски, которую ведёт git, режим доступа.
 *
 * Три случая:
 *   · раздела «Правила» нет — действуют правила по умолчанию (`DEFAULT_RULES`):
 *     защиту дают сам Kaiten и сервер — обязательные поля, ограничения,
 *     создание только в очередях, запрет удалений;
 *   · раздел есть, но блок не разбирается — доска закрыта: кто-то хотел
 *     правила, молча их терять нельзя;
 *   · неописанная колонка, поле или раздел — предупреждение агенту, не отказ.
 *
 * Правила живут в описании доски, а не в git: этот репозиторий публичный и не
 * знает ни проектов, ни id досок, а правка в git требовала бы деплоя.
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const TypeRuleSchema = z
  .object({
    /** Шаблон названия; нет — название свободное. */
    title: z.string().min(1, 'шаблон названия пуст').optional(),
    lane: z.string().min(1).default('default'),
    parent: z.string().min(1).default('none'),
    /** `self` — ответственный сам пользователь, если не назвал другого; `required` — агент обязан назвать. */
    responsible: z.enum(['self', 'required']).default('self'),
    /** Срок при создании: не ставится, можно или обязателен. Менять его потом агент не может. */
    due: z.enum(['none', 'optional', 'required']).default('none'),
    /** Срок, если агент его не назвал: столько рабочих дней от сегодня. */
    due_default: z.number().int().min(1).max(60).optional(),
  })
  .strict()
  .refine((rule) => rule.due_default === undefined || rule.due !== 'none', { message: 'due_default без due: optional или required', path: ['due_default'] });
export type TypeRule = z.infer<typeof TypeRuleSchema>;

const BoardRulesSchema = z
  .object({
    version: z.literal(1),
    /** `read` — агент на доске только читает. */
    access: z.enum(['write', 'read']).default('write'),
    duplicates: z.enum(['board', 'space', 'off']).default('board'),
    /** Сузить колонки создания (из колонок-очередей). */
    columns: z.array(z.string().min(1)).optional(),
    /**
     * Карточки с external_id ведёт git: агент их только комментирует. По
     * умолчанию — да: переписанный блок без этого ключа не должен открыть
     * агенту карточки, которые git потом перезапишет.
     */
    synced: z.boolean().default(true),
    /**
     * `confirm` — комментарий агента уходит только после подтверждения
     * человеком: на доске гости или заказчики, им приходит письмо. Карточки
     * Service Desk подтверждаются всегда, и без этого ключа.
     */
    comments: z.enum(['free', 'confirm']).default('free'),
    /** Тип → правило; `"*"` — любой тип доски. */
    types: z.record(z.string().min(1), TypeRuleSchema).refine((t) => Object.keys(t).length > 0, 'не задано ни одного типа'),
  })
  .strict();
export type BoardRules = z.infer<typeof BoardRulesSchema>;

/** Правила доски без блока: любой тип доски, свободное название, дорожка по умолчанию. */
export const DEFAULT_RULES: BoardRules = BoardRulesSchema.parse({ version: 1, types: { '*': {} } });

export interface ParsedDescription {
  rules: BoardRules;
  /** Текст разделов по заголовку `## …` (без заголовка). */
  sections: Record<string, string>;
  /** Блока правил нет — действуют `DEFAULT_RULES`. */
  defaults: boolean;
  /** Что не так с описанием, но запись не мешает. */
  warnings: string[];
}

export type ParseResult = { ok: true; value: ParsedDescription } | { ok: false; problems: string[] };

function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = text.replace(/\r\n/g, '\n').split(/^##[ \t]+(.+?)[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i].trim()] = (parts[i + 1] ?? '').trim();
  return sections;
}

const TEXT_SECTIONS = ['Доска', 'Этапы', 'Поля'] as const;

/** Разобрать описание доски. Проблемы и предупреждения — по-русски, их видит агент. */
export function parseBoardDescription(description: string | null | undefined): ParseResult {
  const text = description ?? '';
  const sections = splitSections(text);
  const warnings: string[] = [];
  if (!text.trim()) warnings.push('у доски нет описания для агентов — колонки и поля без пояснений');
  else for (const name of TEXT_SECTIONS) if (!(name in sections)) warnings.push(`в описании нет раздела «${name}»`);

  if (!('Правила' in sections)) {
    if (/```ya?ml/.test(text)) warnings.push('блок YAML вне раздела «## Правила» не читается — действуют правила по умолчанию');
    return { ok: true, value: { rules: DEFAULT_RULES, sections, defaults: true, warnings } };
  }

  const block = /```ya?ml[ \t]*\n([\s\S]*?)```/.exec(sections['Правила']);
  if (!block) return { ok: false, problems: ['в разделе «Правила» нет блока ```yaml — уберите раздел или допишите блок'] };
  let raw: unknown;
  try {
    raw = parseYaml(block[1]);
  } catch (error) {
    return { ok: false, problems: [`блок правил не разбирается как YAML: ${(error as Error).message.split('\n')[0]}`] };
  }
  const parsed = BoardRulesSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => `блок правил: ${issue.path.join('.') || 'корень'} — ${issue.message}`) };
  return { ok: true, value: { rules: parsed.data, sections, defaults: false, warnings } };
}

/** Есть ли в тексте раздела пункт про этот объект (`**Название**`). */
export function mentions(sectionText: string | undefined, name: string): boolean {
  if (!sectionText) return false;
  return sectionText.includes(`**${name}**`);
}

/**
 * Полнота описания: каждая колонка — в «Этапах», каждое обязательное или
 * требуемое ограничением поле — в «Полях». Не описано — агент получит отказ
 * Kaiten без пояснения, что значит поле: это предупреждение, не закрытие.
 * Раздела нет вовсе — о нём уже сказано одним предупреждением.
 */
export function coverageProblems(parsed: ParsedDescription, columns: string[], fields: string[]): string[] {
  const problems: string[] = [];
  if ('Этапы' in parsed.sections) for (const column of columns) if (!mentions(parsed.sections['Этапы'], column)) problems.push(`в «Этапах» не описана колонка «${column}»`);
  if ('Поля' in parsed.sections) for (const field of fields) if (!mentions(parsed.sections['Поля'], field)) problems.push(`в «Полях» не описано поле «${field}»`);
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
    .replace(/[\s ]+/g, ' ')
    .trim();
}
