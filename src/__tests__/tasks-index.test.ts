/**
 * Команды чтения CLI `kaiten`: на что агент опирается молча — какая задача
 * найдётся по ключу, чьи задачи у эпика, что попадёт в список продукта и
 * что битый файл не ломает остальные.
 */
import { describe, expect, it } from 'vitest';

import { serializeTaskDocument } from '../core/document.js';
import type { TaskFileText } from '../core/lint.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { belongsToProject, buildIndex, checklistProgress, childrenOf, epicOf, filterTasks, refOf, resolveTask, searchTasks, sortTasks, type TaskRecord } from '../core/tasks-index.js';
import { formatShow, formatTaskLines } from '../kaiten-format.js';

const EPIC_ID = '01K5ZQ3R8F2K9M4N7P0T5V8W2X';
const IDS = ['01K5ZQ3R8F2K9M4N7P0T5V8W3A', '01K5ZQ3R8F2K9M4N7P0T5V8W3B', '01K5ZQ3R8F2K9M4N7P0T5V8W3C', '01K5ZQ3R8F2K9M4N7P0T5V8W3D'];

function file(path: string, fm: Partial<Frontmatter> & { id: string }, body = '## Критерии готовности\n\n- [ ] Пункт\n'): TaskFileText {
  const full = FrontmatterSchema.parse({
    title: 'Сделать задачу',
    summary: 'Задача для теста.',
    type: 'story',
    status: 'backlog',
    repo: 'acme-app',
    created: '2026-09-16',
    created_by: 'alice',
    updated: '2026-09-16',
    ...fm,
  });
  return { path, text: serializeTaskDocument(full, body) };
}

const FILES: TaskFileText[] = [
  // Эпик без repo, ссылаются на него по ключу карточки и по id.
  file('active/onboarding.md', { id: EPIC_ID, tracker: 'PRJ-100', type: 'epic', title: 'Переделать онбординг', repo: undefined, status: 'ready' }, '## Цель\n\nРост.\n'),
  file('active/webhook-timeout.md', { id: IDS[0], tracker: '10000002', type: 'bug', epic: 'PRJ-100', priority: 'p1', title: 'Починить таймаут вебхука', status: 'ready' }, '## Критерии\n\n- [x] Тест\n- [ ] Ретраи\n\n## Шаги\n\n- [ ] Воспроизвести\n'),
  file('active/android-intro.md', { id: IDS[1], epic: EPIC_ID, repo: 'acme-mobile', priority: 'p0', title: 'Показать вступление на android' }),
  file('archive/2026-09/old-intro.md', { id: IDS[2], epic: EPIC_ID, status: 'done', title: 'Убрать старое вступление' }),
  file('active/landing-copy.md', { id: IDS[3], repo: 'acme-site', status: 'inbox', title: 'Переписать тексты лендинга' }),
  { path: 'active/broken.md', text: '---\ntitle: без остального\n---\n' },
];

const LOGS = new Map([['active/webhook-timeout.md', '## [2026-09-20] воспроизвёл на staging, причина в ретраях\n']]);

const index = buildIndex(FILES, LOGS);
const bySlug = (slug: string): TaskRecord => index.tasks.find((t) => t.slug === slug) as TaskRecord;

describe('buildIndex', () => {
  it('битый файл — в problems с тем, что исправить, остальные читаются', () => {
    expect(index.tasks).toHaveLength(5);
    expect(index.problems).toHaveLength(1);
    expect(index.problems[0].path).toBe('active/broken.md');
    expect(index.problems[0].message).toContain('summary: обязательное поле');
  });

  it('журнал лежит рядом с задачей, закрытость — по статусу', () => {
    expect(bySlug('webhook-timeout').log).toContain('staging');
    expect(bySlug('android-intro').log).toBeNull();
    expect(bySlug('old-intro').closed).toBe(true);
  });
});

describe('belongsToProject', () => {
  it('клон чужого проекта не выдаётся за свой; пустой и из одних эпиков проходит', () => {
    expect(belongsToProject(index.tasks, ['acme-app', 'acme-mobile'])).toBe(true);
    expect(belongsToProject(index.tasks, ['globex-site', 'globex-web'])).toBe(false);
    expect(belongsToProject([], ['globex-site'])).toBe(true);
    expect(belongsToProject([bySlug('onboarding')], ['globex-site'])).toBe(true);
  });
});

describe('resolveTask', () => {
  it('находит по ключу без учёта регистра, числовому id, ULID и slug', () => {
    for (const ref of ['PRJ-100', 'prj-100', EPIC_ID, EPIC_ID.toLowerCase(), 'onboarding']) {
      expect(resolveTask(index.tasks, ref)).toEqual({ task: bySlug('onboarding') });
    }
    expect(resolveTask(index.tasks, '10000002')).toEqual({ task: bySlug('webhook-timeout') });
  });

  it('промах — подсказка, как найти', () => {
    const r = resolveTask(index.tasks, 'PRJ-999');
    expect('error' in r && r.error).toContain('kaiten search');
  });

  it('ключ видно как ref, без ключа — slug', () => {
    expect(refOf(bySlug('onboarding'))).toBe('PRJ-100');
    expect(refOf(bySlug('landing-copy'))).toBe('landing-copy');
  });
});

describe('эпик', () => {
  it('дети — и по ключу карточки, и по id эпика, закрытые тоже', () => {
    const epic = bySlug('onboarding');
    expect(childrenOf(index.tasks, epic).map((t) => t.slug).sort()).toEqual(['android-intro', 'old-intro', 'webhook-timeout']);
    expect(epicOf(index.tasks, bySlug('android-intro'))).toBe(epic);
    expect(epicOf(index.tasks, bySlug('landing-copy'))).toBeNull();
  });
});

describe('filterTasks', () => {
  const slugs = (tasks: TaskRecord[]): string[] => tasks.map((t) => t.slug).sort();

  it('по умолчанию только открытые; --closed добавляет закрытые; явный статус сильнее', () => {
    expect(slugs(filterTasks(index.tasks, {}))).not.toContain('old-intro');
    expect(slugs(filterTasks(index.tasks, { closed: true }))).toContain('old-intro');
    expect(slugs(filterTasks(index.tasks, { statuses: ['done'] }))).toEqual(['old-intro']);
  });

  it('эпик без repo виден в продукте, где есть его задача, и не виден в чужом', () => {
    expect(slugs(filterTasks(index.tasks, { repo: 'acme-mobile' }))).toEqual(['android-intro', 'onboarding']);
    expect(slugs(filterTasks(index.tasks, { repo: 'acme-site' }))).toEqual(['landing-copy']);
  });

  it('по эпику и типу', () => {
    expect(slugs(filterTasks(index.tasks, { epic: bySlug('onboarding') }))).toEqual(['android-intro', 'webhook-timeout']);
    expect(slugs(filterTasks(index.tasks, { types: ['bug'] }))).toEqual(['webhook-timeout']);
  });
});

describe('sortTasks', () => {
  it('колонка доски, потом приоритет (без приоритета — в конце)', () => {
    expect(sortTasks(index.tasks).map((t) => t.slug)).toEqual(['landing-copy', 'android-intro', 'webhook-timeout', 'onboarding', 'old-intro']);
  });
});

describe('searchTasks', () => {
  it('нужны все слова; регистр и ё не важны; ищет и в журнале', () => {
    expect(searchTasks(index.tasks, 'ТАЙМАУТ staging').map((h) => h.task.slug)).toEqual(['webhook-timeout']);
    expect(searchTasks(index.tasks, 'вступление').map((h) => h.task.slug).sort()).toEqual(['android-intro', 'old-intro']);
    expect(searchTasks(index.tasks, 'вступление лендинга')).toEqual([]);
    expect(searchTasks(index.tasks, '   ')).toEqual([]);
  });

  it('совпадение не в заголовке — со строкой, где нашлось', () => {
    const [hit] = searchTasks(index.tasks, 'воспроизвести');
    expect(hit.snippet).toBe('- [ ] Воспроизвести');
    expect(searchTasks(index.tasks, 'вебхука')[0].snippet).toBeNull();
  });
});

describe('вывод', () => {
  it('пункты по разделам тела', () => {
    expect(checklistProgress(bySlug('webhook-timeout').body)).toEqual([
      { name: 'Критерии', done: 1, total: 2 },
      { name: 'Шаги', done: 0, total: 1 },
    ]);
  });

  it('строка списка начинается с ключа; у эпика — сколько задач закрыто', () => {
    const lines = formatTaskLines(index.tasks, [bySlug('onboarding'), bySlug('landing-copy')], false);
    const cols = lines.map((l) => l.split(/\s{2,}/));
    expect(cols[0]).toEqual(['PRJ-100', 'ready', '—', 'epic', 'Переделать онбординг · закрыто 1 из 3']);
    expect(cols[1]).toEqual(['landing-copy', 'inbox', '—', 'story', 'Переписать тексты лендинга']);
    // Столбцы выровнены: статус начинается в одной позиции.
    expect(lines[0].indexOf('ready')).toBe(lines[1].indexOf('inbox'));
  });

  it('show: эпик, пункты, журнал и соседние задачи', () => {
    const text = formatShow(index.tasks, bySlug('webhook-timeout'), '/tasks/active/webhook-timeout.md');
    expect(text).toContain('10000002 · bug · ready · приоритет p1 · acme-app');
    expect(text).toContain('Эпик: PRJ-100 — Переделать онбординг');
    expect(text).toContain('Пункты: Критерии 1/2 · Шаги 0/1');
    expect(text).toContain('## Журнал');
    expect(text).toMatch(/## Другие задачи эпика \(2\)[\s\S]*android-intro/);
  });
});
