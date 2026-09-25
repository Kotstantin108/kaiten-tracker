/**
 * Конвертер старых школ в v2: то, что при переносе 600 задач теряется или
 * путается молча, — нестабильные id, статус не из того источника, коллизии
 * slug, битые связи эпиков, ссылки после переезда папок, забытые файлы
 * рядом с TASK.md.
 */
import { describe, expect, it } from 'vitest';

import { convertProject, deriveId, draftSummary, type ConvertInput } from '../convert/convert-plan.js';
import { buildHistory, parseGitLog, type TaskHistory } from '../convert/git-history.js';
import { lintRepository } from '../core/lint.js';
import type { TaskFile } from '../task-source.js';

const REPO_URL = 'https://github.com/acme-org/acme-app';

function task(over: Partial<TaskFile> & { slug: string; date?: string; type?: TaskFile['meta']['type'] }): TaskFile {
  const date = over.date ?? '20260916';
  const type = over.type ?? 'story';
  const repoName = over.repoName ?? 'acme-app';
  const folderName = `${date}_${type}_p1_${over.slug}`;
  return {
    externalId: `${repoName}:${date}_${over.slug}`,
    repoName,
    repoUrl: REPO_URL,
    branch: 'main',
    dir: `tasks/backlog/stories/${folderName}`,
    folderName,
    meta: { date, type, priority: 'p1', slug: over.slug },
    status: 'backlog',
    bucketMonth: null,
    title: `Сделать ${over.slug}`,
    header: { slug: over.slug, title: null, type, priority: 'p1', status: null, parent: null, created: null, related: [] },
    body: '## Мотивация (WHY)\n\nНужно, чтобы работало.\n\n## Критерии готовности\n\n- [ ] Работает\n',
    parentExternalId: null,
    nested: false,
    hasLog: false,
    attachments: [],
    ...over,
  };
}

const commit = (author: string, date: string, agent = false): TaskHistory['first'] => ({ author, date, agent });

function input(tasks: TaskFile[], over: Partial<ConvertInput> = {}): ConvertInput {
  const history = new Map<string, TaskHistory>(tasks.map((t) => [t.externalId, { first: commit('Автор', '2026-09-16', true), last: commit('Автор', '2026-09-20'), closed: null }]));
  return { tasks, history, logs: new Map(), overlay: {}, cards: new Map(), ...over };
}

function file(result: ReturnType<typeof convertProject>, path: string): string {
  const f = result.files.find((x) => x.path === path);
  if (!f) throw new Error(`нет ${path}; есть: ${result.files.map((x) => x.path).join(', ')}`);
  return f.text;
}

describe('история git', () => {
  const log = [
    '\x1eБ\x1f2026-09-20T10:00:00+04:00\x1fзакрыть\x1f\n\nR100\ttasks/backlog/stories/20260916_story_p1_foo/TASK.md\ttasks/done/2026-09/20260916_story_p2_foo/TASK.md\n',
    '\x1eА\x1f2026-09-18T10:00:00+04:00\x1fправка\x1f\n\nM\ttasks/backlog/stories/20260916_story_p1_foo/TASK.md\n',
    '\x1eА\x1f2026-09-16T10:00:00+04:00\x1fзавести\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\x1f\n\nA\ttasks/backlog/stories/20260916_story_p1_foo/TASK.md\nA\ttasks/backlog/stories/20260916_story_p1_foo/LOG.md\n',
  ].join('');

  it('автор — первый коммит, закрыл — переезд в done/, ключ переживает смену приоритета в имени', () => {
    const history = buildHistory(parseGitLog(log), 'folders').get('20260916_foo');
    expect(history).toEqual({ first: commit('А', '2026-09-16', true), last: commit('Б', '2026-09-20'), closed: commit('Б', '2026-09-20') });
  });

  it('нумерованная школа: ключ — имя файла, закрытие — переезд в tasks/done/', () => {
    const numbered = '\x1eВ\x1f2026-09-11T00:00:00Z\x1fdone\x1f\n\nR100\ttasks/0003-home.md\ttasks/done/0003-home.md\n\x1eВ\x1f2026-09-01T00:00:00Z\x1fnew\x1f\n\nA\ttasks/0003-home.md\n';
    expect(buildHistory(parseGitLog(numbered), 'numbered').get('0003-home')?.closed?.date).toBe('2026-09-11');
  });
});

describe('конвертер', () => {
  it('id выводится из ключа и даты, результат не зависит от порядка входа', () => {
    const tasks = [task({ slug: 'a' }), task({ slug: 'b' }), task({ slug: 'c' })];
    const one = convertProject(input(tasks));
    const two = convertProject(input([...tasks].reverse()));
    expect(two.files).toEqual(one.files);
    expect(one.tasks[0].frontmatter.id).toBe(deriveId('acme-app:20260916_a', '2026-09-16'));
    expect(one.tasks[0].frontmatter.id.startsWith('01M2KR6R00')).toBe(true);
  });

  it('статус — по папке, расхождение с шапкой в отчёте; blocked и cancelled не теряются', () => {
    const blocked = task({ slug: 'wait', status: 'blocked', header: { ...task({ slug: 'x' }).header, status: 'todo' } });
    const cancelled = task({ slug: 'drop', status: 'cancelled', bucketMonth: '2026-08' });
    const result = convertProject(input([blocked, cancelled]));
    expect(result.tasks.map((t) => [t.path, t.frontmatter.status])).toEqual([
      ['archive/2026-08/drop.md', 'cancelled'],
      ['active/wait.md', 'blocked'],
    ]);
    expect(result.report.statusMismatch).toEqual([{ externalId: blocked.externalId, header: 'todo', folder: 'blocked' }]);
  });

  it('карточка Kaiten: tracker заполнен, статус взят из Kaiten, задача уезжает в архив', () => {
    const t = task({ slug: 'format' });
    const result = convertProject(input([t], { cards: new Map([[t.externalId, { id: 10000002, status: 'done' }]]) }));
    expect(result.tasks[0].frontmatter.tracker).toBe('10000002');
    expect(result.tasks[0].path).toBe('archive/2026-09/format.md');
    expect(result.report.kaitenStatus).toEqual([{ externalId: t.externalId, folder: 'backlog', kaiten: 'done' }]);
    // Закрыли в Kaiten, не в git — строку «закрыто по git» не выдумываем.
    expect(result.files.some((f) => f.path.endsWith('.log.md'))).toBe(false);
  });

  it('коллизия slug между репозиториями решается детерминированно, с записью в отчёт', () => {
    const app = task({ slug: 'hero' });
    const landing = task({ slug: 'hero', repoName: 'acme-site', date: '20260901' });
    const result = convertProject(input([landing, app]));
    expect(result.tasks.map((t) => t.slug).sort()).toEqual(['hero', 'hero-20260901']);
    expect(result.report.slugRenames).toEqual([{ externalId: landing.externalId, from: 'hero', to: 'hero-20260901' }]);
  });

  it('родитель: у эпика — id эпика; не-эпик родителем не становится, а попадает в отчёт', () => {
    const epic = task({ slug: 'migration', type: 'epic' });
    const child = task({ slug: 'format', parentExternalId: epic.externalId });
    const story = task({ slug: 'wow' });
    const orphan = task({ slug: 'wiring', parentExternalId: story.externalId });
    const result = convertProject(input([epic, child, story, orphan]));
    const byslug = new Map(result.tasks.map((t) => [t.slug, t.frontmatter]));
    expect(byslug.get('format')?.epic).toBe(byslug.get('migration')?.id);
    expect(byslug.get('wiring')?.epic).toBeUndefined();
    expect(result.report.parentProblems).toEqual([{ externalId: orphan.externalId, problem: 'родитель wow — story, не эпик — связь не перенесена' }]);
  });

  it('ссылки: на задачу — путь в репозитории задач, на свой файл — вложение, на код — постоянная ссылка', () => {
    const other = task({ slug: 'other', status: 'in-progress', dir: 'tasks/in-progress/20260916_story_p1_other', date: '20260916' });
    const body = [
      '## Критерии готовности',
      '',
      '- [ ] [соседняя](../../../tasks/in-progress/20260916_story_p1_other/TASK.md) и [её лог](../20260916_story_p1_other/LOG.md)',
      '- [ ] [исследование](RESEARCH.md), [ассеты](assets/), [схема](../../../docs/SCHEMA.md#x)',
      '',
    ].join('\n');
    const t = task({ slug: 'main', body });
    const result = convertProject(
      input([t, other], {
        extraFiles: new Map([[t.externalId, ['RESEARCH.md', 'assets/a.png']]]),
        exists: (_repo, path) => path === 'docs/SCHEMA.md',
      }),
    );
    const text = file(result, 'active/main.md');
    expect(text).toContain('[соседняя](/active/other.md)');
    // Ссылка написана с глубины `backlog/stories/`, а соседняя лежит в `in-progress/`: база подбирается.
    expect(text).toContain('[её лог](/active/other.log.md)');
    expect(text).toContain('[исследование](/attachments/main/RESEARCH.md)');
    expect(text).toContain('[ассеты](/attachments/main/assets/)');
    expect(text).toContain(`[схема](${REPO_URL}/blob/main/docs/SCHEMA.md#x)`);
    expect(result.attachments).toEqual([
      { repoName: 'acme-app', from: `${t.dir}/RESEARCH.md`, to: 'attachments/main/RESEARCH.md' },
      { repoName: 'acme-app', from: `${t.dir}/assets/a.png`, to: 'attachments/main/assets/a.png' },
    ]);
    expect(result.report.unresolvedLinks).toEqual([]);
  });

  it('закрытая по git задача: строка «кем закрыто» первой в журнале, дальше старый LOG.md', () => {
    const t = task({ slug: 'done-one', status: 'done', bucketMonth: '2026-05', hasLog: true });
    const result = convertProject(
      input([t], {
        history: new Map([[t.externalId, { first: commit('А', '2026-05-01'), last: commit('Б', '2026-05-10'), closed: commit('Б', '2026-05-09') }]]),
        logs: new Map([[t.externalId, '# LOG\r\n\r\n- сделано\r\n']]),
      }),
    );
    expect(file(result, 'archive/2026-05/done-one.log.md')).toBe(
      '- 2026-05-09 — закрыто: Б (по истории git при переносе в формат v2)\n\n# LOG\n\n- сделано\n',
    );
    expect(result.tasks[0].frontmatter).toMatchObject({ created_by: 'А', created_via: 'human', updated: '2026-05-10' });
  });

  it('папка без приоритета — без priority; «Суть» — из оверлея, иначе черновик на проверку', () => {
    const lenient = task({ slug: 'visual-check', meta: { date: '20260909', type: 'bug', priority: null, slug: 'visual-check' } });
    const pilot = task({ slug: 'pilot' });
    const result = convertProject(input([lenient, pilot], { overlay: { [pilot.externalId]: { summary: 'Проверим Kaiten до оплаты.', team: 'Менеджмент' } } }));
    const bySlug = new Map(result.tasks.map((t) => [t.slug, t.frontmatter]));
    expect(bySlug.get('visual-check')?.priority).toBeUndefined();
    expect(bySlug.get('pilot')).toMatchObject({ summary: 'Проверим Kaiten до оплаты.', team: 'Менеджмент' });
    expect(result.report.summaryDrafts).toEqual([lenient.externalId]);
  });

  it('нумерованная школа globex: фаза — в planning.phase, «Зависит от» — в related', () => {
    const base = (n: string, slug: string, body: string): TaskFile =>
      task({
        slug: `${n}-${slug}`,
        repoName: 'globex-site',
        externalId: `globex-site:${n}-${slug}`,
        meta: { date: '', type: 'story', priority: null, slug: `${n}-${slug}` },
        dir: 'tasks',
        sourceFile: `tasks/${n}-${slug}.md`,
        body,
      });
    const home = base('0003', 'home', '## Критерии готовности\n\n- [ ] Есть\n');
    const product = base('0004', 'product', '**Фаза:** 3\n**Зависит от:** 0003\n\nСм. [главную](0003-home.md).\n\n## Критерии готовности\n\n- [ ] Есть\n');
    const result = convertProject(input([home, product]));
    const fm = result.tasks.find((t) => t.slug === '0004-product')?.frontmatter;
    expect(fm?.planning).toEqual({ phase: '3' });
    expect(fm?.related).toEqual(['0003-home']);
    expect(fm?.created).toBe('2026-09-16');
    expect(file(result, 'active/0004-product.md')).toContain('[главную](/active/0003-home.md)');
  });

  it('результат проходит схему и линтер без ошибок', () => {
    const result = convertProject(input([task({ slug: 'a' }), task({ slug: 'b', status: 'done', bucketMonth: '2026-09' })]));
    const lint = lintRepository(result.files.filter((f) => !f.path.endsWith('.log.md')));
    expect(lint.errors).toBe(0);
  });
});

describe('черновик «Сути»', () => {
  it('первый абзац мотивации без разметки, не длиннее 300 знаков', () => {
    const body = '## Мотивация (WHY)\n\nСейчас **статус** хранится в [двух](x.md) местах. Это ломает `sync`. Третье. Четвёртое.\n\n## Что\n';
    expect(draftSummary(body, 'Заголовок')).toBe('Сейчас статус хранится в двух местах. Это ломает sync. Третье.');
    expect(draftSummary(`## Зачем\n\n${'слово '.repeat(100)}`, 'x').length).toBeLessThanOrEqual(300);
    expect(draftSummary('## Шаги\n\n- [ ] один\n', 'Заголовок')).toBe('один');
  });
});
