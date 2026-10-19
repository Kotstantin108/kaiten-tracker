/**
 * Команды чтения CLI `kaiten`: на что агент опирается молча — какая задача
 * найдётся по ключу, чьи задачи у эпика, что попадёт в список продукта и
 * что битый файл не ломает остальные.
 */
import { describe, expect, it } from 'vitest';

import { serializeTaskDocument } from '../core/document.js';
import type { TaskFileText } from '../core/lint.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { belongsToProject, buildIndex, checklistProgress, childrenOf, epicOf, filterTasks, refOf, resolveTask, SearchQueryError, searchTasks, sortTasks, stem, type TaskRecord } from '../core/tasks-index.js';
import { openCriteria } from '../kaiten-write.js';
import { formatLogTail, formatOutline, formatProblems, formatSearch, formatSection, formatShow, formatTaskLines, formatTodo, presentBody, progressLine } from '../kaiten-format.js';

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

  it('ищет и в текстовых вложениях — с подписью, в каком файле', () => {
    const attachments = new Map([['webhook-timeout', [{ name: 'trace.log', text: 'запрос 1\nretry-after 30s\n' }]]]);
    expect(searchTasks(index.tasks, 'retry-after')).toEqual([]);
    const [hit] = searchTasks(index.tasks, 'retry-after', { attachments });
    expect(hit.task.slug).toBe('webhook-timeout');
    expect(hit.snippet).toBe('вложение trace.log: retry-after 30s');
    const [withLines] = searchTasks(index.tasks, 'retry-after', { attachments, lines: true });
    expect(withLines.lines).toEqual([{ where: 'вложение trace.log', text: 'retry-after 30s', hit: true, gap: false }]);
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
    const text = formatShow(index.tasks, bySlug('webhook-timeout'), ['trace.log']);
    expect(text).toContain('10000002 · bug · ready · приоритет p1 · acme-app');
    expect(text).toContain('Эпик: PRJ-100 — Переделать онбординг');
    expect(text).toContain('Пункты: Критерии 1/2 · Шаги 0/1');
    expect(text).toContain('Вложения (1): kaiten files 10000002');
    expect(text).toContain('## Журнал');
    expect(text).toMatch(/## Другие задачи эпика \(2\)[\s\S]*android-intro/);
    // Где лежат задачи, вывод не называет.
    expect(text).not.toMatch(/active\/|archive\/|\.md\b/);
  });

  it('ни поиск, ни журнал, ни нечитаемые задачи не называют путей', () => {
    const tasks = buildIndex(
      [
        file(
          'active/linked.md',
          { id: IDS[0], title: 'Связать задачи' },
          // Ссылка на границе обрезки строки поиска: обрежь до замены — половина пути утечёт.
          `## Критерии готовности\n\n- [ ] Сверить по пилоту ${'а '.repeat(50)}[старое](/archive/2026-09/old-intro.md)\n`,
        ),
        file('archive/2026-09/old-intro.md', { id: IDS[1], status: 'done' }),
        { path: 'active/broken.md', text: '---\ntitle: без остального\n---\n' },
      ],
      new Map([['active/linked.md', 'Итог в [отчёте](/attachments/linked/report.md)\n']]),
    );
    const all = tasks.tasks;
    const hits = searchTasks(all, 'связать пилоту');
    const searched = formatSearch(all, hits, true).join('\n');
    const shown = formatShow(all, all[0], []);
    const problems = formatProblems(tasks.problems).join('\n');
    expect(presentBody(all, hits[0].snippet ?? '')).toContain('(kaiten show old-intro)');
    expect(searched).toContain('…');
    expect(shown).toContain('(kaiten files linked report.md)');
    expect(problems).toContain('  broken: ');
    for (const text of [searched, shown, problems]) expect(text).not.toMatch(/\/(?:active|archive|attachments)\b|\w\.md\b(?! ?\))|\]\(\//);
    expect(problems).not.toContain('broken.md');
  });

  it('ссылки на задачи и вложения показаны командами, а не путями', () => {
    const body = 'См. [старое](/archive/2026-09/old-intro.md#итог), [эпик](/active/onboarding.md) и [отчёт](/attachments/onboarding/RESEARCH%20v2.md).';
    expect(presentBody(index.tasks, body)).toBe(
      'См. [старое](kaiten show old-intro), [эпик](kaiten show PRJ-100) и [отчёт](kaiten files PRJ-100 RESEARCH v2.md).',
    );
  });
});

describe('поиск: словоформы, варианты, выражения', () => {
  const slugs = (query: string, options = {}): string[] => searchTasks(index.tasks, query, options).map((h) => h.task.slug).sort();

  it('окончания русских слов не важны; --exact — как написано', () => {
    expect(stem('онбордингом')).toBe('онбординг');
    expect(stem('пустом')).toBe('пуст');
    // Короткое слово и латиница не режутся.
    expect(stem('тест')).toBe('тест');
    expect(stem('staging')).toBe('staging');
    expect(slugs('онбордингом')).toEqual(['onboarding']);
    expect(slugs('ретраями таймаутом')).toEqual(['webhook-timeout']);
    expect(slugs('онбордингом', { exact: true })).toEqual([]);
  });

  it('a|b — любой из вариантов, остальные слова по-прежнему обязательны', () => {
    expect(slugs('android|лендинг')).toEqual(['android-intro', 'landing-copy']);
    expect(slugs('android|лендинг вступление')).toEqual(['android-intro']);
  });

  it('выражение: построчно, без регистра; кривое — понятная ошибка', () => {
    expect(slugs('^## \\[2026-09-2\\d\\]', { regex: true })).toEqual(['webhook-timeout']);
    expect(slugs('ВСТУПЛЕНИ[ея] на', { regex: true })).toEqual(['android-intro']);
    expect(() => searchTasks(index.tasks, '(', { regex: true })).toThrow(SearchQueryError);
  });

  it('--lines: все совпавшие строки с подписью, откуда они, и соседними', () => {
    const [hit] = searchTasks(index.tasks, 'ретраи|воспроизв', { lines: true });
    expect(hit.lines?.filter((l) => l.hit).map((l) => [l.where, l.text])).toEqual([
      ['Критерии', '- [ ] Ретраи'],
      ['Шаги', '- [ ] Воспроизвести'],
      ['журнал 2026-09-20', '## [2026-09-20] воспроизвёл на staging, причина в ретраях'],
    ]);
    // Запись со временем и автором подписана той же датой.
    const timed = buildIndex(FILES, new Map([['active/webhook-timeout.md', '## [2026-10-19 21:43:26 +03:00 · alice] ретраи с паузой\nпроверил тестом\n']]));
    const [later] = searchTasks(timed.tasks, 'проверил', { lines: true });
    expect(later.lines?.filter((l) => l.hit).map((l) => l.where)).toEqual(['журнал 2026-10-19']);
    const [wide] = searchTasks(index.tasks, 'ретраи', { lines: true, context: 1, exact: true });
    expect(wide.lines?.map((l) => (l.hit ? '+' : ' ') + l.text)).toEqual([' - [x] Тест', '+- [ ] Ретраи']);
    const text = formatSearch(index.tasks, [hit], false).join('\n');
    expect(text).toContain('    Критерии ▸ - [ ] Ретраи');
    expect(text).toContain('    журнал 2026-09-20 ▸ ');
  });
});

describe('задача по частям', () => {
  const task = (): TaskRecord => bySlug('webhook-timeout');

  it('оглавление: разделы, пункты, журнал, вложения', () => {
    const text = formatOutline(task(), ['trace.log']);
    expect(text).toContain('10000002 · ready · Починить таймаут вебхука');
    expect(text).toContain('## Критерии — строк 2, пунктов 1/2');
    expect(text).toContain('## Шаги — строк 1, пунктов 0/1');
    expect(text).toContain('Журнал: записей 1, последняя — [2026-09-20]');
    expect(text).toContain('Вложения (1): trace.log');
  });

  it('раздел по словам названия; нет раздела — null', () => {
    expect(formatSection(index.tasks, task(), 'шаг')).toContain('## Шаги\n\n- [ ] Воспроизвести');
    expect(formatSection(index.tasks, task(), 'шаг')).not.toContain('Ретраи');
    expect(formatSection(index.tasks, task(), 'нет такого')).toBeNull();
  });

  it('подразделы идут вместе с разделом и не повторяются', () => {
    const big = buildIndex([file('active/big.md', { id: IDS[0] }, '## План\n\nтекст\n\n### План: этап 1\n\n- [ ] раз\n\n## Итог\n\nвсё\n')]).tasks;
    const text = formatSection(big, big[0], 'план') ?? '';
    expect(text.match(/### План: этап 1/g)).toHaveLength(1);
    expect(text).not.toContain('Итог');
  });

  it('только неотмеченное; хвост журнала; счёт пунктов', () => {
    const todo = formatTodo(index.tasks, task());
    expect(todo).toContain('Критерии:\n  - [ ] Ретраи');
    expect(todo).not.toContain('- [x] Тест');
    expect(formatTodo(index.tasks, bySlug('onboarding'))).toContain('В задаче нет пунктов.');
    expect(formatLogTail(index.tasks, task(), 3)).toContain('Журнал (1):');
    expect(formatLogTail(index.tasks, bySlug('android-intro'), 3)).toContain('Журнал пуст.');
    expect(progressLine(task())).toBe('Пункты: Критерии 1/2 · Шаги 0/1');
  });
});

describe('перед ревью', () => {
  it('неотмеченные критерии — только из раздела критериев, шаги не считаются', () => {
    expect(openCriteria(bySlug('webhook-timeout').body)).toEqual(['Ретраи']);
    expect(openCriteria('## Вопрос\n\nтекст\n\n## Ответ\n\n')).toEqual([]);
    expect(openCriteria('## Критерии готовности\n\n- [x] раз\n- [X] два\n\n## Шаги\n\n- [ ] шаг\n')).toEqual([]);
  });

  it('хвост журнала называет вложения — там лежит передача дел', () => {
    expect(formatLogTail(index.tasks, bySlug('webhook-timeout'), 1, ['HANDOFF.md'])).toContain('Вложения (1): HANDOFF.md — kaiten files 10000002 <файл>');
  });
});
