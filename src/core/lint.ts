/**
 * Линтер одного файла задачи v2. Ошибка — CLI такой файл не запишет и не
 * отправит; предупреждение — эвристика, решает человек.
 *
 * Ошибки: схема (обязательные поля, незнакомые ключи, форматы), файл лежит
 * не в той папке для своего статуса, имя файла — не slug.
 * Предупреждения: «Суть» длиннее 300 знаков (владелец 25.09: смягчить), в
 * «Сути» термины кода, больше трёх предложений, заголовок не с глагола,
 * нет критериев, спайк закрыт без ответа, «Шаги» в эпике, файл не в
 * каноническом виде.
 */

import { z } from 'zod';

import { parseTaskDocument, serializeTaskDocument, TaskParseError, type RawTaskDocument } from './document.js';
import { CLOSED_STATUSES, FrontmatterSchema, type Frontmatter } from './schema.js';
import { countChecklistItems, criteriaText, sectionText, SKELETONS, SPIKE_ANSWER_SECTION } from './skeleton.js';

export interface LintIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface LintContext {
  /** Путь файла относительно корня репозитория задач: `active/x.md`, `archive/2026-09/x.md`. */
  path?: string;
  /** Допустимые значения `repo` для проекта (варианты поля «Репозиторий <Проект>»). */
  repos?: readonly string[];
}

export interface LintResult {
  issues: LintIssue[];
  /** Разобранная шапка, если прошла схему. */
  frontmatter: Frontmatter | null;
}

export const SUMMARY_MAX = 300;

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Глагол в начале заголовка: инфинитив («Починить», «Перенести», «Беречь»),
 * в том числе возвратный. Эвристика, поэтому только предупреждение.
 */
const VERB_RE = /^[А-ЯЁа-яё]+(?:ть|ти|чь)(?:ся|сь)?$/;

/** Признаки «языка кода» в тексте для фаундера. */
const CODE_TERMS: Array<[RegExp, string]> = [
  [/`/, 'обратные кавычки'],
  [/\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|py|sql|ya?ml|env)\b/, 'имя файла'],
  [/(?:^|\s)[\w.-]*\/[\w./-]+/, 'путь'],
  [/\b[a-z]+[A-Z][A-Za-z0-9]*\b/, 'camelCase'],
  [/\b[a-z0-9]+_[a-z0-9_]+\b/, 'snake_case'],
];

function sentenceCount(text: string): number {
  return text.split(/[.!?…]+(?:\s+|$)/).filter((s) => s.trim().length > 0).length;
}

function checkFileName(path: string, issues: LintIssue[]): void {
  const file = path.replace(/\\/g, '/').split('/').at(-1) ?? '';
  if (!file.endsWith('.md') || !SLUG_RE.test(file.replace(/\.md$/, ''))) {
    issues.push({ level: 'error', message: `имя файла — только slug латиницей через дефис: ${file}` });
  }
}

function checkLocation(fm: Frontmatter, path: string, issues: LintIssue[]): void {
  const parts = path.replace(/\\/g, '/').split('/');
  const closed = CLOSED_STATUSES.includes(fm.status);
  if (parts[0] === 'active' && parts.length === 2) {
    if (closed) issues.push({ level: 'error', message: `статус ${fm.status}, а файл в active/: закрытые задачи живут в archive/YYYY-MM/` });
  } else if (parts[0] === 'archive' && parts.length === 3 && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(parts[1])) {
    if (!closed) issues.push({ level: 'error', message: `статус ${fm.status}, а файл в archive/: там только done и cancelled` });
  } else {
    issues.push({ level: 'error', message: `файл задачи должен лежать в active/ или archive/YYYY-MM/: ${path}` });
  }
}

/** Сообщения схемы по-русски; отсутствующее поле называется прямо, без «получено undefined». */
const ruError = z.locales.ru().localeError;
const schemaError: z.core.$ZodErrorMap = (issue) =>
  issue.input === undefined && (issue.code === 'invalid_type' || issue.code === 'invalid_value') ? 'обязательное поле' : ruError(issue);

export function lintTask(text: string, context: LintContext = {}): LintResult {
  const issues: LintIssue[] = [];
  if (context.path) checkFileName(context.path, issues);

  let raw: RawTaskDocument;
  try {
    raw = parseTaskDocument(text);
  } catch (error) {
    if (!(error instanceof TaskParseError)) throw error;
    issues.push({ level: 'error', message: error.message });
    return { issues, frontmatter: null };
  }

  const parsed = FrontmatterSchema.safeParse(raw.data, { error: schemaError });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.') || '(шапка)';
      issues.push({ level: 'error', message: `${field}: ${issue.message}` });
    }
    return { issues, frontmatter: null };
  }
  const fm = parsed.data;
  const { body } = raw;

  if (fm.summary.length > SUMMARY_MAX) {
    issues.push({ level: 'warning', message: `summary: ${fm.summary.length} знаков, «Суть» — до ${SUMMARY_MAX}` });
  }
  if (sentenceCount(fm.summary) > 3) {
    issues.push({ level: 'warning', message: 'summary: больше трёх предложений — «Суть» пишется в 1–3' });
  }
  const terms = CODE_TERMS.filter(([re]) => re.test(fm.summary)).map(([, label]) => label);
  if (terms.length > 0) {
    issues.push({ level: 'warning', message: `summary: похоже на термины кода (${terms.join(', ')}) — «Суть» читают фаундер и менеджеры` });
  }

  const firstWord = fm.title.trim().split(/\s+/)[0] ?? '';
  if (!VERB_RE.test(firstWord)) {
    issues.push({ level: 'warning', message: `title: начинайте с глагола («Починить…», «Перенести…»), сейчас «${firstWord}»` });
  }

  if (context.repos && fm.repo !== undefined && !context.repos.includes(fm.repo)) {
    issues.push({ level: 'error', message: `repo: «${fm.repo}» нет среди репозиториев проекта (${context.repos.join(', ')})` });
  }

  const skeleton = SKELETONS[fm.type];
  // Критерии необязательны (владелец 28.09.2026): задача бывает общей —
  // «разобраться», «исследовать», — и критерии появляются по ходу работы.
  // Раздел в скелете остаётся, линтер только напоминает.
  const bodyLevel: LintIssue['level'] = 'warning';
  if (skeleton.criteria) {
    const criteria = sectionText(body, skeleton.criteria) ?? criteriaText(body);
    if (criteria === null) {
      issues.push({ level: bodyLevel, message: `нет раздела «${skeleton.criteria}»` });
    } else if (countChecklistItems(criteria) === 0) {
      issues.push({ level: bodyLevel, message: `в разделе «${skeleton.criteria}» нет ни одного пункта \`- [ ]\`` });
    }
  }
  if (fm.type === 'spike' && fm.status === 'done' && !sectionText(body, SPIKE_ANSWER_SECTION)?.trim()) {
    issues.push({ level: 'warning', message: `спайк закрыт, а раздел «${SPIKE_ANSWER_SECTION}» пуст` });
  }
  if (fm.type === 'epic') {
    const steps = sectionText(body, 'Шаги');
    if (steps !== null && countChecklistItems(steps) > 0) {
      issues.push({ level: 'warning', message: 'у эпика «Шаги» чекбоксами: работа эпика — дочерние задачи с полем epic:' });
    }
  }

  if (context.path) checkLocation(fm, context.path, issues);

  if (serializeTaskDocument(fm, body) !== text.replace(/\r\n/g, '\n')) {
    issues.push({ level: 'warning', message: 'файл не в каноническом виде (порядок ключей, кавычки) — перепишет любая команда записи' });
  }

  return { issues, frontmatter: fm };
}

export interface TaskFileText {
  /** Путь относительно корня репозитория задач. */
  path: string;
  text: string;
}

export interface RepositoryLint {
  byFile: Array<{ path: string; issues: LintIssue[] }>;
  errors: number;
  warnings: number;
}

/**
 * Весь репозиторий задач: каждый файл плюс то, что видно только на всём
 * наборе, — повторы `id` и slug. Slug обязан быть уникален и между active/ и
 * archive/: ссылаются на задачу по slug, а не по пути (story `export-csv`).
 */
export function lintRepository(files: readonly TaskFileText[], repos?: readonly string[]): RepositoryLint {
  const byFile = files.map((file) => ({ path: file.path, ...lintTask(file.text, { path: file.path, repos }) }));

  const seen = (key: (f: (typeof byFile)[number]) => string | null, label: string): void => {
    const groups = new Map<string, string[]>();
    for (const f of byFile) {
      const k = key(f);
      if (k) groups.set(k, [...(groups.get(k) ?? []), f.path]);
    }
    for (const [k, paths] of groups) {
      if (paths.length < 2) continue;
      for (const f of byFile.filter((x) => paths.includes(x.path))) {
        f.issues.push({ level: 'error', message: `${label} ${k} повторяется: ${paths.join(', ')}` });
      }
    }
  };
  seen((f) => f.frontmatter?.id ?? null, 'id');
  seen((f) => f.path.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.md$/, '') ?? null, 'slug');

  const result = byFile.map(({ path, issues }) => ({ path, issues }));
  const count = (level: LintIssue['level']): number => result.reduce((n, f) => n + f.issues.filter((i) => i.level === level).length, 0);
  return { byFile: result, errors: count('error'), warnings: count('warning') };
}
