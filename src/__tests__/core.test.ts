/**
 * Формат задачи v2: то, что ломает синхронизацию молча — нестабильный порядок
 * ключей (шумные диффы), даты, превращённые в `Date`, хеш, который меняется
 * от служебных полей, и критерии, которые линтер ищет не в том разделе.
 */
import { describe, expect, it } from 'vitest';

import { contentHash, foreignFieldChanges, parseTaskDocument, serializeTaskDocument, TaskParseError } from '../core/document.js';
import { lintRepository, lintTask, type LintIssue } from '../core/lint.js';
import { FrontmatterSchema, type Frontmatter, type TaskType } from '../core/schema.js';
import { renderSkeleton, sectionText } from '../core/skeleton.js';
import { ulid } from '../core/ulid.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W2X';

const CANONICAL = `---
id: ${ID}
tracker: PRJ-123
title: "Починить таймаут вебхука: ретраи #2"
summary: Оплата иногда не подтверждается, и пользователь видит ошибку. Чиним повторную доставку.
type: bug
status: inbox
repo: acme-app
epic: PRJ-100
related:
  - docs/architecture/AI_SYSTEM.md
created: 2026-09-16
created_by: alice
created_via: agent
updated: 2026-09-25
content_hash: sha256:${'a'.repeat(64)}
---

## Что происходит

Таймаут.

## Критерии

- [ ] Тест на таймаут
`;

function frontmatter(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return FrontmatterSchema.parse({
    id: ID,
    title: 'Перенести задачи в базу',
    summary: 'Задачи всех проектов живут в одном месте.',
    type: 'story',
    status: 'backlog',
    repo: 'acme-app',
    created: '2026-09-16',
    created_by: 'alice',
    created_via: 'human',
    updated: '2026-09-16',
    ...overrides,
  });
}

function filled(type: TaskType): string {
  return renderSkeleton(type).replace('- [ ] \n', '- [ ] Пункт\n');
}

function messages(issues: LintIssue[], level: LintIssue['level']): string[] {
  return issues.filter((i) => i.level === level).map((i) => i.message);
}

describe('ulid', () => {
  it('26 символов Crockford, время в префиксе', () => {
    expect(ulid(0, new Uint8Array(10))).toBe('0'.repeat(26));
    expect(ulid(2 ** 48 - 1, new Uint8Array(10).fill(255))).toBe(`7${'Z'.repeat(25)}`);
    expect(ulid()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(ulid(1000)).not.toBe(ulid(1000));
  });
});

describe('parse / serialize', () => {
  it('канонический файл переживает круг без единого изменения', () => {
    const raw = parseTaskDocument(CANONICAL);
    const fm = FrontmatterSchema.parse(raw.data);
    expect(serializeTaskDocument(fm, raw.body)).toBe(CANONICAL);
  });

  it('даты остаются строками, двоеточие и решётка в заголовке не ломают YAML', () => {
    const fm = FrontmatterSchema.parse(parseTaskDocument(CANONICAL).data);
    expect(fm.created).toBe('2026-09-16');
    expect(fm.title).toBe('Починить таймаут вебхука: ретраи #2');
  });

  it('порядок ключей — из таблицы полей, а не из пришедшего объекта', () => {
    const fm = frontmatter({ priority: 'p1', tracker: 'PRJ-1', planning: { due: '2026-10-01', assignee: 'k' } });
    const reversed = Object.fromEntries(Object.entries(fm).reverse()) as Frontmatter;
    const text = serializeTaskDocument(reversed, '\nТело\n');
    const keys = text.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['id', 'tracker', 'title', 'summary', 'type', 'status', 'repo', 'priority', 'created', 'created_by', 'created_via', 'updated', 'planning']);
    expect(text).toContain('planning:\n  assignee: k\n  due: 2026-10-01\n');
  });

  it('CRLF читается, как LF', () => {
    const raw = parseTaskDocument(CANONICAL.replace(/\n/g, '\r\n'));
    expect(FrontmatterSchema.parse(raw.data).id).toBe(ID);
    expect(raw.body.startsWith('\n## Что происходит')).toBe(true);
  });

  it('без frontmatter, без закрывающей черты, с повтором ключа — ошибка разбора', () => {
    expect(() => parseTaskDocument('# Задача\n')).toThrow(TaskParseError);
    expect(() => parseTaskDocument('---\nid: x\n')).toThrow(TaskParseError);
    expect(() => parseTaskDocument('---\nid: a\nid: b\n---\n')).toThrow(TaskParseError);
  });
});

describe('схема', () => {
  it('без summary, с незнакомым ключом, с битым id — отказ', () => {
    const { data } = parseTaskDocument(CANONICAL);
    const base = data as Record<string, unknown>;
    expect(FrontmatterSchema.safeParse({ ...base, summary: undefined }).success).toBe(false);
    expect(FrontmatterSchema.safeParse({ ...base, Status: 'todo' }).success).toBe(false);
    expect(FrontmatterSchema.safeParse({ ...base, id: 'task-1' }).success).toBe(false);
  });

  it('числовой id карточки без кавычек и пустое необязательное поле читаются', () => {
    const text = CANONICAL.replace('tracker: PRJ-123', 'tracker: 10000002').replace('epic: PRJ-100', 'epic: 71007999').replace(/^related:\n.*\n/m, 'related:\n');
    const { issues, frontmatter: fm } = lintTask(text);
    expect(fm?.tracker).toBe('10000002');
    expect(fm?.epic).toBe('71007999');
    expect(fm?.related).toBeUndefined();
    expect(messages(issues, 'error')).toEqual([]);
    expect(messages(issues, 'warning')).toEqual(['файл не в каноническом виде (порядок ключей, кавычки) — перепишет любая команда записи']);
    const out = serializeTaskDocument(fm as Frontmatter, parseTaskDocument(text).body);
    expect(out).toContain('tracker: "10000002"\n');
    expect(out).toContain('epic: "71007999"\n');
    expect(out).not.toContain('related');
  });

  it('repo необязателен только у эпика, родителя у эпика нет', () => {
    const { data } = parseTaskDocument(CANONICAL);
    const { repo: _repo, epic: _epic, ...rest } = data as Record<string, unknown>;
    expect(FrontmatterSchema.safeParse({ ...rest, type: 'story' }).success).toBe(false);
    expect(FrontmatterSchema.safeParse({ ...rest, type: 'epic' }).success).toBe(true);
    expect(FrontmatterSchema.safeParse({ ...rest, type: 'epic', epic: 'PRJ-1' }).success).toBe(false);
  });
});

describe('content_hash и владельцы полей', () => {
  it('не меняется от служебных полей и зеркал Kaiten, меняется от текста', () => {
    const fm = frontmatter();
    const hash = contentHash(fm, 'Тело\n');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(contentHash({ ...fm, updated: '2027-01-01', tracker: 'PRJ-9', status: 'done', priority: 'p0', planning: { due: '2026-10-01' } }, 'Тело\n\n')).toBe(hash);
    expect(contentHash({ ...fm, title: 'Перенести всё' }, 'Тело\n')).not.toBe(hash);
    expect(contentHash(fm, 'Тело и ещё\n')).not.toBe(hash);
  });

  it('правка поля Kaiten или CLI видна, правка поля файла — нет', () => {
    const before = frontmatter();
    expect(foreignFieldChanges(before, { ...before, title: 'Другое', repo: 'acme-site' })).toEqual([]);
    expect(foreignFieldChanges(before, { ...before, priority: 'p0', status: 'done', id: '01K5ZQ3R8F2K9M4N7P0T5V8W2Y' })).toEqual(['id', 'status', 'priority']);
  });
});

describe('скелет и раздел критериев по типу', () => {
  it.each(['story', 'tech', 'bug', 'epic', 'spike'] as const)('заполненный скелет %s проходит без ошибок', (type) => {
    const fm = frontmatter({ type, ...(type === 'epic' ? { repo: undefined } : {}) });
    const { issues } = lintTask(serializeTaskDocument(fm, `\n${filled(type)}`));
    expect(messages(issues, 'error')).toEqual([]);
  });

  it('пустой пункт скелета — не критерий', () => {
    const { issues } = lintTask(serializeTaskDocument(frontmatter({ type: 'bug' }), `\n${renderSkeleton('bug')}`));
    expect(messages(issues, 'error')).toEqual([]);
    expect(messages(issues, 'warning')).toContain('в разделе «Критерии» нет ни одного пункта `- [ ]`');
  });

  it('раздел ищется по имени и не заходит в следующий, заголовки в коде не считаются', () => {
    const body = '## Критерии готовности\n\n```\n## Шаги\n```\n- [ ] А\n\n### Подраздел\n- [ ] Б\n\n## Шаги\n\n- [ ] В\n';
    expect(sectionText(body, 'Критерии готовности')).toBe('\n```\n## Шаги\n```\n- [ ] А\n\n### Подраздел\n- [ ] Б\n');
    expect(sectionText(body, 'Нет такого')).toBeNull();
  });

  it('спайк закрыт без ответа — предупреждение линтера (ошибкой его делает закрытие)', () => {
    const fm = frontmatter({ type: 'spike', status: 'done' });
    expect(messages(lintTask(serializeTaskDocument(fm, `\n${renderSkeleton('spike')}`)).issues, 'warning')).toContain('спайк закрыт, а раздел «Ответ» пуст');
    const answered = renderSkeleton('spike').replace('## Ответ\n\n', '## Ответ\n\nДа, работает.\n');
    expect(messages(lintTask(serializeTaskDocument(fm, `\n${answered}`)).issues, 'warning')).not.toContain('спайк закрыт, а раздел «Ответ» пуст');
  });

  it('старые заголовки критериев засчитываются, у закрытой задачи нехватка критериев — предупреждение', () => {
    const legacy = '\n## Критерии готовности (эпик)\n\n- [x] Готово\n';
    expect(messages(lintTask(serializeTaskDocument(frontmatter({ type: 'bug' }), legacy)).issues, 'error')).toEqual([]);
    const empty = '\n## Что сделали\n\nВсё.\n';
    expect(messages(lintTask(serializeTaskDocument(frontmatter({ status: 'done' }), empty)).issues, 'error')).toEqual([]);
    // Критерии необязательны и у живых задач: только напоминание.
    expect(messages(lintTask(serializeTaskDocument(frontmatter(), empty)).issues, 'error')).toEqual([]);
    expect(messages(lintTask(serializeTaskDocument(frontmatter(), empty)).issues, 'warning')).toContain('нет раздела «Критерии готовности»');
  });

  it('«Шаги» чекбоксами у эпика — предупреждение', () => {
    const body = `\n${filled('epic')}\n## Шаги\n\n- [ ] Сделать всё\n`;
    const { issues } = lintTask(serializeTaskDocument(frontmatter({ type: 'epic', repo: undefined }), body));
    expect(messages(issues, 'warning')).toContain('у эпика «Шаги» чекбоксами: работа эпика — дочерние задачи с полем epic:');
  });
});

describe('линтер', () => {
  const lint = (fm: Frontmatter, path?: string, repos?: string[]): LintIssue[] =>
    lintTask(serializeTaskDocument(fm, `\n${filled(fm.type)}`), { path, repos }).issues;

  it('длинная «Суть», термины кода и заголовок не с глагола — предупреждения, не ошибки', () => {
    const long = lint(frontmatter({ summary: 'а'.repeat(301) }));
    expect(messages(long, 'error')).toEqual([]);
    expect(messages(long, 'warning')).toEqual(['summary: 301 знаков, «Суть» — до 300']);
    const warnings = messages(lint(frontmatter({ title: 'Формат задач v2', summary: 'Правим `parseTask` в src/core.ts.' })), 'warning');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('обратные кавычки, имя файла, путь, camelCase');
    expect(warnings[1]).toContain('«Формат»');
  });

  it('iPhone и iOS — названия продуктов, не camelCase', () => {
    expect(messages(lint(frontmatter({ summary: 'На iPhone с iOS 18 не было звука — исправлено.' })), 'warning')).toEqual([]);
    expect(messages(lint(frontmatter({ summary: 'Правим iPhoneHandler.' })), 'warning')[0]).toContain('camelCase');
  });

  it('возвратный глагол — тоже глагол', () => {
    expect(messages(lint(frontmatter({ title: 'Разобраться с ретраями' })), 'warning')).toEqual([]);
  });

  it('папка должна соответствовать статусу, имя файла — slug', () => {
    expect(messages(lint(frontmatter(), 'active/tasks-move.md'), 'error')).toEqual([]);
    expect(messages(lint(frontmatter({ status: 'done' }), 'archive/2026-09/tasks-move.md'), 'error')).toEqual([]);
    expect(messages(lint(frontmatter({ status: 'done' }), 'active/tasks-move.md'), 'error')[0]).toContain('в active/');
    expect(messages(lint(frontmatter(), 'archive/2026-09/tasks-move.md'), 'error')[0]).toContain('в archive/');
    expect(messages(lint(frontmatter({ status: 'done' }), 'archive/2026-13/tasks-move.md'), 'error')[0]).toContain('active/ или archive/YYYY-MM/');
    expect(messages(lint(frontmatter(), 'active/Tasks_Move.md'), 'error')[0]).toContain('только slug');
  });

  it('repo сверяется с репозиториями проекта', () => {
    expect(messages(lint(frontmatter({ repo: 'globex-site' }), undefined, ['acme-app']), 'error')[0]).toContain('globex-site');
  });

  it('неканонический файл — предупреждение, не ошибка', () => {
    const text = CANONICAL.replace(`id: ${ID}\ntracker: PRJ-123\n`, `tracker: PRJ-123\nid: ${ID}\n`);
    const { issues } = lintTask(text);
    expect(messages(issues, 'error')).toEqual([]);
    expect(messages(issues, 'warning').some((m) => m.includes('каноническом'))).toBe(true);
  });

  it('ошибки схемы называют поле', () => {
    const { issues, frontmatter: fm } = lintTask(CANONICAL.replace('created_via: agent', 'created_via: robot'));
    expect(fm).toBeNull();
    expect(issues[0].message.startsWith('created_via:')).toBe(true);
    expect(lintTask(CANONICAL.replace(/^summary: .*\n/m, '')).issues.map((i) => i.message)).toEqual(['summary: обязательное поле']);
  });

  it('повтор id и slug по всему репозиторию, включая архив', () => {
    const a = serializeTaskDocument(frontmatter(), `\n${filled('story')}`);
    const done = serializeTaskDocument(frontmatter({ status: 'done', id: '01K5ZQ3R8F2K9M4N7P0T5V8W2Y' }), `\n${filled('story')}`);
    const result = lintRepository([
      { path: 'active/one.md', text: a },
      { path: 'active/two.md', text: a },
      { path: 'archive/2026-09/one.md', text: done },
    ]);
    expect(result.errors).toBe(4);
    expect(result.byFile[1].issues.map((i) => i.message)).toEqual([`id ${ID} повторяется: active/one.md, active/two.md`]);
    expect(result.byFile[2].issues.map((i) => i.message)).toEqual(['slug one повторяется: active/one.md, archive/2026-09/one.md']);
  });
});
