/**
 * «Находки»: заметка агента, проверка ответа исследователя и путь находки
 * через операции — от заметки до задачи в «Находках».
 */
import { describe, expect, it } from 'vitest';

import { foundSetting } from '../config.js';
import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import {
  findingPath,
  findingPrompt,
  listFindings,
  newFindingText,
  parseFinding,
  verifyFinding,
  type Finding,
  type FindingAnswer,
  type FindingCheck,
} from '../core/found.js';
import { juniorReadiness } from '../core/junior.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { startProblem } from '../core/start.js';
import { applyOp, assignedPriority, CANCELLABLE, type FileChange, type TaskTexts } from '../core/task-ops.js';
import { buildIndex, type TaskRecord } from '../core/tasks-index.js';
import { verdictOp } from '../kaiten-found.js';
import { desiredForProject, planSetup, type CurrentStructure } from '../setup-plan.js';

const NOTE_ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const TASK_ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3B';
const CTX = { date: '2026-11-12', stamp: '2026-11-12 10:15:00 +03:00' };
const HEAD = { branch: 'main', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };

function noteText(): string {
  const text = newFindingText(
    { id: NOTE_ID, repo: 'acme-app', from: 'export-orders', createdBy: 'alice', title: 'Дата в заголовке отчёта — месяц/день/год', where: 'src/report/header.ts:41', seen: '3 октября выводится как 10/3/2026.\n## Как должно быть\nдень.месяц.год' },
    '2026-11-12',
  );
  if (typeof text !== 'string') throw new Error(text.error);
  return text;
}

function note(): Finding {
  const parsed = parseFinding(noteText());
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function taskText(overrides: Partial<Frontmatter> = {}): string {
  const fm = FrontmatterSchema.parse({
    id: TASK_ID,
    title: 'Выгрузить заказы в отчёт',
    summary: 'Отчёт по заказам за месяц.',
    type: 'story',
    status: 'in-progress',
    repo: 'acme-app',
    created: '2026-11-01',
    created_by: 'alice',
    updated: '2026-11-01',
    ...overrides,
  });
  return serializeTaskDocument(fm, '## Зачем\n\nНужен отчёт.\n\n## Что сделать\n\nВыгрузка.\n\n## Критерии готовности\n\n- [ ] Дата в отчёте — день.месяц.год\n');
}

function record(overrides: Partial<Frontmatter> = {}, path = 'active/export-orders.md'): TaskRecord {
  return buildIndex([{ path, text: taskText(overrides) }]).tasks[0];
}

const FILES: Record<string, string> = {
  'code/src/report/header.ts': ['import { formatDate } from "../format";', '', 'export function header(date: Date): string {', '  return `Отчёт за ${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;', '}'].join('\n'),
  'code/src/format.test.ts': ['it("день.месяц.год", () => {', '  expect(formatDate(new Date(2026, 9, 3))).toBe("03.10.2026");', '});'].join('\n'),
  'tasks/active/export-orders.md': taskText(),
};

const CHECK: FindingCheck = {
  readFile: (path) => FILES[path] ?? null,
  findTask: (ref) => (ref === 'export-orders' ? record() : null),
};

function answer(overrides: Partial<FindingAnswer> = {}): FindingAnswer {
  return {
    verdict: 'confirmed',
    reason: 'Заголовок отчёта собирает дату вручную в порядке месяц/день/год, а тест форматирования требует день.месяц.год.',
    duplicate_of: '',
    title: 'Починить порядок даты в заголовке отчёта',
    slug: 'fix-report-header-date',
    summary: 'Дата в заголовке отчёта читается как месяц/день/год: 3 октября выглядит как 10/3.',
    what_happens: 'В заголовке отчёта дата в порядке месяц/день/год.',
    reproduce: '1. Сформировать отчёт 3 октября — в заголовке 10/3/2026.',
    expected: 'День.месяц.год, как в остальном отчёте: 03.10.2026.',
    criteria: ['Дата в заголовке отчёта — день.месяц.год', '- [ ] Есть тест на дату с однозначным днём'],
    evidence: [
      { role: 'actual', path: 'code/src/report/header.ts', line: 4, quote: 'return `Отчёт за ${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;', note: 'дата собрана вручную, месяц первым' },
      { role: 'expected', path: 'code/src/format.test.ts', line: 2, quote: 'expect(formatDate(new Date(2026, 9, 3))).toBe("03.10.2026");', note: 'тест требует день.месяц.год' },
    ],
    ...overrides,
  };
}

describe('заметка', () => {
  it('пишется и читается; заголовки в тексте агента не ломают разделы', () => {
    const n = note();
    expect([n.fm.state, n.fm.repo, n.fm.from, n.fm.created_by]).toEqual(['pending', 'acme-app', 'export-orders', 'alice']);
    expect(n.title).toBe('Дата в заголовке отчёта — месяц/день/год');
    expect(n.where).toBe('src/report/header.ts:41');
    expect(n.seen).toBe('3 октября выводится как 10/3/2026.\nКак должно быть\nдень.месяц.год');
    expect(n.reason).toBeNull();
  });

  it('без места или причины не записывается', () => {
    const base = { id: NOTE_ID, repo: 'acme-app', createdBy: 'alice', title: 'Что-то не так', where: 'экран заказа', seen: 'падает' };
    expect(newFindingText({ ...base, where: ' ' }, '2026-11-12')).toEqual({ error: 'не сказано, где это видно' });
    expect(newFindingText({ ...base, seen: '' }, '2026-11-12')).toEqual({ error: 'не сказано, почему это дефект' });
  });

  it('список — только читаемые заметки из findings/', () => {
    const files = [
      { path: findingPath(NOTE_ID), text: noteText() },
      { path: 'findings/broken.md', text: 'не заметка' },
      { path: 'active/export-orders.md', text: taskText() },
    ];
    expect(listFindings(files).map((f) => f.fm.id)).toEqual([NOTE_ID]);
  });
});

describe('проверка ответа исследователя', () => {
  it('подтверждена: доказательства сошлись — задача с разделами бага и «Доказательствами»', () => {
    const verdict = verifyFinding(note(), answer(), CHECK, HEAD);
    if (verdict.state !== 'confirmed') throw new Error(verdict.reason);
    expect(verdict.task.slug).toBe('fix-report-header-date');
    expect(verdict.task.body).toContain('## Что происходит');
    expect(verdict.task.body).toContain('- [ ] Дата в заголовке отчёта — день.месяц.год\n- [ ] Есть тест на дату с однозначным днём');
    expect(verdict.task.body).toContain('по ветке main (коммит a1b2c3d4e5)');
    expect(verdict.task.body).toContain('- `src/report/header.ts:4` — дата собрана вручную, месяц первым');
    expect(verdict.task.body).toContain('- `src/format.test.ts:2` — тест требует день.месяц.год');
    // Допуск младшему пишет не тот, кто нашёл.
    expect(verdict.task.body).not.toMatch(/Продуктовые решения|Изменения в БД|Сценарии n8n/);
  });

  it('номер строки съехал — берётся настоящий; строки в файле нет — не подтверждена', () => {
    const moved = answer();
    moved.evidence[0] = { ...moved.evidence[0], line: 40 };
    const verdict = verifyFinding(note(), moved, CHECK, HEAD);
    expect(verdict.state === 'confirmed' && verdict.task.body).toContain('`src/report/header.ts:4`');

    const invented = answer();
    invented.evidence[0] = { ...invented.evidence[0], quote: 'return formatUsDate(date); // такого в файле нет' };
    const rejected = verifyFinding(note(), invented, CHECK, HEAD);
    expect(rejected.state).toBe('rejected');
    expect(rejected.reason).toContain('в основной ветке нет такой строки: code/src/report/header.ts:4');
  });

  it('нет источника «как должно быть» — это улучшение, а не дефект', () => {
    const verdict = verifyFinding(note(), answer({ evidence: answer().evidence.slice(0, 1) }), CHECK, HEAD);
    expect(verdict.state).toBe('rejected');
    expect(verdict.reason).toContain('это улучшение, а не дефект');
  });

  it('место дефекта — только в коде; путь наружу и чужая папка не принимаются', () => {
    const inTask = answer();
    inTask.evidence[0] = { role: 'actual', path: 'tasks/active/export-orders.md', line: 1, quote: 'title: Выгрузить заказы в отчёт', note: 'задача' };
    expect(verifyFinding(note(), inTask, CHECK, HEAD).reason).toContain('место дефекта названо не в коде');

    const outside = answer();
    outside.evidence[1] = { ...outside.evidence[1], path: '../secrets.txt' };
    expect(verifyFinding(note(), outside, CHECK, HEAD).reason).toContain('путь вне снимка');
  });

  it('источник «как должно быть» может быть задачей проекта — ссылкой в карточке', () => {
    const fromTask = answer();
    fromTask.evidence[1] = { role: 'expected', path: 'tasks/active/export-orders.md', line: 20, quote: '- [ ] Дата в отчёте — день.месяц.год', note: 'критерий задачи' };
    const verdict = verifyFinding(note(), fromTask, CHECK, HEAD);
    expect(verdict.state === 'confirmed' && verdict.task.body).toContain('- [задача export-orders](/active/export-orders.md) — критерий задачи');
  });

  it('повтор — только существующей задачи', () => {
    const dup = verifyFinding(note(), answer({ verdict: 'duplicate', duplicate_of: 'export-orders.md' }), CHECK, HEAD);
    expect(dup.state === 'duplicate' && dup.of.slug).toBe('export-orders');
    const ghost = verifyFinding(note(), answer({ verdict: 'duplicate', duplicate_of: 'no-such-task' }), CHECK, HEAD);
    expect(ghost.state).toBe('rejected');
  });

  it('rejected остаётся rejected с причиной исследователя', () => {
    expect(verifyFinding(note(), answer({ verdict: 'rejected', reason: 'В основной ветке дата уже форматируется общей функцией.' }), CHECK, HEAD)).toEqual({
      state: 'rejected',
      reason: 'В основной ветке дата уже форматируется общей функцией.',
    });
  });

  it('задание называет снимок основной ветки и задачу, из которой нашли', () => {
    const prompt = findingPrompt({ finding: note(), head: HEAD, from: record() });
    expect(prompt).toContain('ветка main, коммит a1b2c3d4e5');
    expect(prompt).toContain('Где: src/report/header.ts:41');
    expect(prompt).toContain('tasks/active/export-orders.md');
    expect(prompt).toContain('Сомневаешься между confirmed и rejected — rejected');
  });
});

describe('операции', () => {
  const base = (): TaskTexts => new Map([['active/export-orders.md', taskText()]]);
  const ok = (result: ReturnType<typeof applyOp>): FileChange[] => {
    if ('error' in result) throw new Error(result.error);
    return result.changes;
  };
  const withNote = (): Map<string, string> => {
    const texts = new Map(base());
    for (const c of ok(applyOp({ kind: 'found-note', id: NOTE_ID, text: noteText() }, texts, CTX))) texts.set(c.path, c.text ?? '');
    return texts;
  };

  it('заметка — файлом в findings/, задачей не считается', () => {
    const texts = withNote();
    expect([...texts.keys()]).toEqual(['active/export-orders.md', findingPath(NOTE_ID)]);
    expect(applyOp({ kind: 'found-note', id: NOTE_ID, text: noteText() }, texts, CTX)).toEqual({ error: 'такая находка уже записана' });
    // Заметка не мешает операциям над задачами и не занимает их имён.
    expect('error' in applyOp({ kind: 'log', id: TASK_ID, text: 'проверил' }, texts, CTX)).toBe(false);
  });

  it('подтверждена — задача bug в «Находках» и вердикт в заметке одним шагом', () => {
    const texts = withNote();
    const verdict = verifyFinding(note(), answer(), CHECK, HEAD);
    const op = verdictOp(note(), verdict, CTX.date);
    if ('error' in op) throw new Error(op.error);
    const changes = ok(applyOp(op, texts, CTX));
    expect(changes.map((c) => c.path)).toEqual(['active/fix-report-header-date.md', findingPath(NOTE_ID)]);
    const fm = FrontmatterSchema.parse(parseTaskDocument(changes[0].text ?? '').data);
    expect([fm.type, fm.status, fm.priority, fm.created_via, fm.created_by, fm.repo, fm.related]).toEqual(['bug', 'found', undefined, 'agent', 'alice', 'acme-app', ['export-orders']]);
    const resolved = parseFinding(changes[1].text ?? '');
    if ('error' in resolved) throw new Error(resolved.error);
    expect([resolved.fm.state, resolved.fm.task, resolved.fm.resolved]).toEqual(['confirmed', 'fix-report-header-date', '2026-11-12']);

    // Повторный вердикт (второй исследователь, скрипт владельца) ничего не меняет.
    for (const c of changes) texts.set(c.path, c.text ?? '');
    expect(ok(applyOp({ kind: 'found-verdict', id: NOTE_ID, state: 'rejected', reason: 'поздно' }, texts, CTX))).toEqual([]);
  });

  it('не подтверждена и повтор — только заметка, задачи нет', () => {
    const rejected = ok(applyOp({ kind: 'found-verdict', id: NOTE_ID, state: 'rejected', reason: 'В основной ветке этого нет.' }, withNote(), CTX));
    expect(rejected.map((c) => c.path)).toEqual([findingPath(NOTE_ID)]);
    const parsed = parseFinding(rejected[0].text ?? '');
    expect('error' in parsed || [parsed.fm.state, parsed.reason]).toEqual(['rejected', 'В основной ветке этого нет.']);

    const dup = ok(applyOp({ kind: 'found-verdict', id: NOTE_ID, state: 'duplicate', reason: 'Уже есть.', task: { slug: 'export-orders' } }, withNote(), CTX));
    const dupNote = parseFinding(dup[0].text ?? '');
    expect('error' in dupNote || [dupNote.fm.state, dupNote.fm.task]).toEqual(['duplicate', 'export-orders']);
    expect(applyOp({ kind: 'found-verdict', id: NOTE_ID, state: 'duplicate', reason: 'Уже есть.', task: { slug: 'gone' } }, withNote(), CTX)).toEqual({
      error: 'задачи, повтором которой названа находка, больше нет',
    });
  });
});

describe('находка и работа', () => {
  const foundTask = record({ type: 'bug', status: 'found' }, 'active/fix-report-header-date.md');

  it('в работу — только по прямому поручению человека, с высшим приоритетом', () => {
    expect(startProblem(foundTask, 'acme-app')).toContain('задача в «Находках»: в работу берут из «Готово к работе»');
    expect(startProblem(foundTask, 'acme-app', true)).toBeNull();
    expect(assignedPriority(foundTask, true)).toBe('p0');
    expect(CANCELLABLE).toContain('found');
  });

  it('«Можно младшему» — только после разбора: ни в «Находках», ни во «Входящих» признака нет', () => {
    const body = '## Продуктовые решения\nНет.\n\n## Изменения в БД\nНет.\n\n## Сценарии n8n\nНет.\n';
    const at = (status: Frontmatter['status']): ReturnType<typeof juniorReadiness> => juniorReadiness({ type: 'bug', status, created: '2026-11-12', revised: '2026-11-12' }, body, { today: '2026-11-12', maxAgeDays: 90 });
    expect(at('found')).toBeNull();
    expect(at('inbox')).toBeNull();
    expect(at('backlog')).toEqual({ ok: true, missing: [] });
    expect(at('ready')).toEqual({ ok: true, missing: [] });
  });
});

describe('настройка проекта', () => {
  const kaiten = { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme', departments: [], archiveInKaiten: false };

  it('находки включены блоком в конфиге и работают после колонки в маппинге', () => {
    expect(foundSetting({ kaiten, mapping: undefined })).toEqual({ state: 'off' });
    const on = { ...kaiten, found: { model: 'claude-opus-5-5' } };
    expect(foundSetting({ kaiten: on, mapping: { boardId: 1, columns: { inbox: 11 } } })).toEqual({ state: 'needs-setup' });
    expect(foundSetting({ kaiten: on, mapping: { boardId: 1, columns: { found: 10, inbox: 11 } } })).toEqual({ state: 'on', model: 'claude-opus-5-5' });
  });

  it('колонка «Находки» — левее «Входящих» на уже существующей доске', () => {
    const desired = desiredForProject({ space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme', repoLabels: [], teams: [], found: true });
    expect(desired.columns[0]).toEqual({ status: 'found', title: 'Находки', type: 1 });
    expect(desiredForProject({ space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme', repoLabels: [], teams: [] }).columns.some((c) => c.status === 'found')).toBe(false);

    const columns = desired.columns.slice(1).map((c, i) => ({ id: 100 + i, title: c.title, type: c.type, sort_order: i + 1 }));
    const current: CurrentStructure = { spaces: [{ id: 1, title: 'Acme' }], boards: [{ id: 2, title: 'Задачи', columns, lanes: [] }], cardTypes: [], properties: [], selectValues: {} };
    const created = planSetup(current, desired).actions.filter((a) => a.kind === 'create-column');
    expect(created).toEqual([{ kind: 'create-column', title: 'Находки', type: 1, sortOrder: 0.5 }]);
  });
});
