/**
 * Тесты плана заливки. Главное, что здесь проверяется, — идемпотентность:
 * второй прогон по неизменившемуся репозиторию не должен порождать ни одной
 * записи. Без этого цикл сверки будет трогать все 454 карточки каждый проход.
 */
import { describe, expect, it } from 'vitest';

import { buildPlan, renderDescription, type BoardMapping, type ExistingCard } from '../plan.js';
import type { TaskFile } from '../task-source.js';

const mapping: BoardMapping = {
  boardId: 7,
  columns: { inbox: 10, backlog: 11, 'in-progress': 12, blocked: 13, done: 14, cancelled: 15 },
  types: { epic: 1, story: 2, tech: 3, bug: 4, spike: 5 },
  priorityProperty: { id: 42, values: { p0: 'p0', p1: 'p1', p2: 'p2', p3: 'p3', pn: 'pn' } },
  repoProperty: { id: 43 },
};

const render = { rewriteLinks: true };

const task = (over: Partial<TaskFile> & Pick<TaskFile, 'externalId' | 'title'>): TaskFile => ({
  repoName: 'acme-app',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
  dir: `tasks/backlog/stories/${over.externalId}`,
  folderName: over.externalId,
  meta: { date: '20260916', type: 'story', priority: 'p1', slug: 'slug' },
  status: 'backlog',
  bucketMonth: null,
  header: { slug: null, title: null, type: null, priority: null, status: null, parent: null, created: null, related: [] },
  body: '## Мотивация (WHY)\n\nТекст задачи.',
  parentExternalId: null,
  nested: false,
  hasLog: false,
  attachments: [],
  ...over,
});

const asExisting = (id: number, t: TaskFile): ExistingCard => ({
  id,
  externalId: t.externalId,
  title: t.title,
  columnId: mapping.columns[t.status],
  description: renderDescription(t, render),
});

describe('renderDescription', () => {
  it('кладёт тело как есть и добавляет ссылку на папку задачи', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача' });
    const out = renderDescription(t, render);
    expect(out).toContain('## Мотивация (WHY)');
    expect(out).toContain('https://github.com/acme/repo/tree/main/tasks/backlog/stories/20260916_x');
    expect(out).toMatch(/<!-- kaiten-sync:[a-f0-9]{16} -->/);
  });

  it('упоминает LOG.md и вложения, которые остаются в git', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача', hasLog: true, attachments: ['track-card-layout.png'] });
    const out = renderDescription(t, render);
    expect(out).toContain('LOG.md');
    expect(out).toContain('track-card-layout.png');
  });
});

describe('buildPlan', () => {
  it('без карточек планирует только создание', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача' });
    const plan = buildPlan({ tasks: [t], existing: new Map(), mapping, render, linkEpics: false });
    expect(plan.stats).toMatchObject({ create: 1, update: 0, unchanged: 0 });
    const action = plan.actions[0];
    expect(action.kind).toBe('create');
    if (action.kind === 'create') {
      expect(action.payload.external_id).toBe('20260916_x');
      expect(action.payload.text_format_type_id).toBe(1);
      expect(action.payload.column_id).toBe(11);
      expect(action.payload.type_id).toBe(2);
      expect(action.payload.properties).toEqual({ id_42: ['p1'], id_43: 'acme-app' });
    }
  });

  it('второй прогон по тем же данным не даёт записей', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача' });
    const existing = new Map([[t.externalId, asExisting(100, t)]]);
    const plan = buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false });
    expect(plan.stats).toMatchObject({ create: 0, update: 0, unchanged: 1 });
  });

  it('изменённое тело задачи даёт обновление', () => {
    const before = task({ externalId: '20260916_x', title: 'Задача' });
    const existing = new Map([[before.externalId, asExisting(100, before)]]);
    const after = { ...before, body: '## Мотивация (WHY)\n\nДругой текст.' };
    const plan = buildPlan({ tasks: [after], existing, mapping, render, linkEpics: false });
    expect(plan.stats.update).toBe(1);
    const action = plan.actions[0];
    if (action.kind === 'update') {
      expect(action.reasons).toContain('тело задачи');
      expect(action.payload.description).toBeDefined();
    }
  });

  it('колонку существующей карточки не трогает: статусом после создания владеет Kaiten (Q30)', () => {
    const before = task({ externalId: '20260916_x', title: 'Задача' });
    const existing = new Map([[before.externalId, asExisting(100, before)]]);
    const moved = { ...before, status: 'in-progress' as const, dir: 'tasks/in-progress/20260916_x' };
    const plan = buildPlan({ tasks: [moved], existing, mapping, render, linkEpics: false });
    const action = plan.actions[0];
    // Обновление тела возможно (путь папки входит в описание), колонки — нет.
    if (action.kind === 'update') {
      expect(action.payload.column_id).toBeUndefined();
      expect(action.reasons.some((r) => r.startsWith('колонка'))).toBe(false);
    }
  });

  it('чек-листы: новая карточка везёт их с собой, у существующей досоздаются только недостающие по имени', () => {
    const t = task({ externalId: '20260916_c', title: 'С пунктами', body: '## Критерии\n\n- [ ] один\n\n## Шаги\n\n- [x] два\n' });
    const created = buildPlan({ tasks: [t], existing: new Map(), mapping, render, linkEpics: false }).actions[0];
    expect(created.kind === 'create' && created.checklists.map((c) => c.name)).toEqual(['Агент · Критерии', 'Агент · Шаги']);
    expect(created.kind === 'create' && created.payload.description).not.toContain('- [ ]');

    const existing = new Map([[t.externalId, { ...asExisting(100, t), checklists: [{ id: 7, name: 'Агент · Критерии', itemTexts: ['один'] }] }]]);
    const plan = buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false });
    const lists = plan.actions.find((a) => a.kind === 'checklists');
    expect(lists?.kind === 'checklists' && lists.checklists).toEqual([{ name: 'Агент · Шаги', items: [{ text: 'два', checked: true }] }]);
  });

  it('частично созданный чек-лист (оборванный прогон) добивается недостающими пунктами', () => {
    const t = task({ externalId: '20260916_p', title: 'П', body: '## Критерии\n\n- [ ] один\n- [ ] два\n- [x] три\n' });
    const existing = new Map([[t.externalId, { ...asExisting(100, t), checklists: [{ id: 7, name: 'Агент · Критерии', itemTexts: ['один'] }] }]]);
    const lists = buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false }).actions.find((a) => a.kind === 'checklists');
    expect(lists?.kind === 'checklists' && lists.checklists).toEqual([
      { name: 'Агент · Критерии', checklistId: 7, items: [{ text: 'два', checked: false }, { text: 'три', checked: true }] },
    ]);
  });

  it('чек-лист пилота без префикса «Агент · » переименовывается, а не создаётся второй раз', () => {
    const t = task({ externalId: '20260916_l', title: 'Л', body: '## Критерии\n\n- [ ] один\n' });
    const existing = new Map([[t.externalId, { ...asExisting(100, t), checklists: [{ id: 9, name: 'Критерии', itemTexts: ['один'] }] }]]);
    const lists = buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false }).actions.find((a) => a.kind === 'checklists');
    expect(lists?.kind === 'checklists' && lists.checklists).toEqual([{ name: 'Агент · Критерии', items: [], checklistId: 9, rename: true }]);
  });

  it('человеческий чек-лист (без префикса, другое имя) не трогается', () => {
    const t = task({ externalId: '20260916_h', title: 'Х', body: '## Критерии\n\n- [ ] один\n' });
    const existing = new Map([
      [t.externalId, { ...asExisting(100, t), checklists: [{ id: 5, name: 'Агент · Критерии', itemTexts: ['один'] }, { id: 6, name: 'Приёмка', itemTexts: ['x'] }] }],
    ]);
    expect(buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false }).actions.some((a) => a.kind === 'checklists')).toBe(false);
  });

  it('«Репозиторий»-выбор: вариант при создании, обновление у существующей, предупреждение для неизвестного', () => {
    const selectMapping: BoardMapping = {
      ...mapping,
      repoProperty: { id: 43, values: { 'acme-app': 501 } },
      teamProperty: { id: 44, values: { Разработка: 601 } },
      defaultTeam: 'Разработка',
    };
    const t = task({ externalId: '20260916_r', title: 'Р' });
    const created = buildPlan({ tasks: [t], existing: new Map(), mapping: selectMapping, render, linkEpics: false }).actions[0];
    expect(created.kind === 'create' && created.payload.properties).toEqual({ id_42: ['p1'], id_43: [501], id_44: [601] });

    const stale = new Map([[t.externalId, { ...asExisting(100, t), properties: { id_43: 'acme-app', id_44: [601] } }]]);
    const update = buildPlan({ tasks: [t], existing: stale, mapping: selectMapping, render, linkEpics: false }).actions[0];
    expect(update.kind === 'update' && update.payload.properties).toEqual({ id_43: [501] });
    expect(update.kind === 'update' && update.reasons).toEqual(['репозиторий']);

    const empty = new Map([[t.externalId, { ...asExisting(100, t), properties: { id_43: [501] } }]]);
    const filled = buildPlan({ tasks: [t], existing: empty, mapping: selectMapping, render, linkEpics: false }).actions[0];
    expect(filled.kind === 'update' && filled.payload.properties).toEqual({ id_44: [601] });
    const chosen = new Map([[t.externalId, { ...asExisting(100, t), properties: { id_43: [501], id_44: [777] } }]]);
    expect(buildPlan({ tasks: [t], existing: chosen, mapping: selectMapping, render, linkEpics: false }).actions[0].kind).toBe('unchanged');

    const other = { ...t, repoName: 'acme-mobile' };
    const warned = buildPlan({ tasks: [other], existing: new Map(), mapping: selectMapping, render, linkEpics: false });
    expect(warned.warnings[0].detail).toContain('acme-mobile');
  });

  it('связь, видная только со стороны эпика, тоже считается существующей', () => {
    const epic = task({
      externalId: '20260916_epic',
      title: 'Эпик',
      meta: { date: '20260916', type: 'epic', priority: 'p1', slug: 'epic' },
    });
    const story = task({ externalId: '20260916_story', title: 'Стори', parentExternalId: '20260916_epic' });
    // Живой случай: эпик в архиве, у story parents_ids = null, у эпика children_ids = [story].
    const existing = new Map([
      ['20260916_epic', { id: 1, externalId: '20260916_epic', childIds: [2] }],
      ['20260916_story', { id: 2, externalId: '20260916_story', parentIds: [] }],
    ]);
    expect(buildPlan({ tasks: [story, epic], existing, mapping, render, linkEpics: true }).stats.link).toBe(0);
  });

  it('непрочитанное описание не выдаётся за совпадение', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача' });
    const existing = new Map([[t.externalId, { id: 100, externalId: t.externalId, title: t.title, columnId: 11 }]]);
    const plan = buildPlan({ tasks: [t], existing, mapping, render, linkEpics: false });
    const action = plan.actions[0];
    expect(action.kind).toBe('update');
    if (action.kind === 'update') expect(action.reasons).toContain('описание карточки не прочитано');
  });

  it('эпики планируются раньше своих задач', () => {
    const epic = task({
      externalId: '20260916_epic',
      title: 'Эпик',
      meta: { date: '20260916', type: 'epic', priority: 'p1', slug: 'epic' },
    });
    const story = task({ externalId: '20260916_story', title: 'Стори', parentExternalId: '20260916_epic' });
    const plan = buildPlan({ tasks: [story, epic], existing: new Map(), mapping, render, linkEpics: true });
    const creates = plan.actions.filter((a) => a.kind === 'create').map((a) => a.externalId);
    expect(creates).toEqual(['20260916_epic', '20260916_story']);
    expect(plan.stats.link).toBe(1);
  });

  it('уже существующая связь не планируется повторно, неизвестная — планируется', () => {
    const epic = task({
      externalId: '20260916_epic',
      title: 'Эпик',
      meta: { date: '20260916', type: 'epic', priority: 'p1', slug: 'epic' },
    });
    const story = task({ externalId: '20260916_story', title: 'Стори', parentExternalId: '20260916_epic' });
    const linked = new Map([
      ['20260916_epic', { id: 1, externalId: '20260916_epic', parentIds: [] }],
      ['20260916_story', { id: 2, externalId: '20260916_story', parentIds: [1] }],
    ]);
    expect(buildPlan({ tasks: [story, epic], existing: linked, mapping, render, linkEpics: true }).stats.link).toBe(0);

    const unknown = new Map([
      ['20260916_epic', { id: 1, externalId: '20260916_epic' }],
      ['20260916_story', { id: 2, externalId: '20260916_story' }],
    ]);
    expect(buildPlan({ tasks: [story, epic], existing: unknown, mapping, render, linkEpics: true }).stats.link).toBe(1);
  });

  it('родитель вне выборки не ломает заливку, а попадает в предупреждения', () => {
    const story = task({ externalId: '20260916_story', title: 'Стори', parentExternalId: '20260916_epic' });
    const plan = buildPlan({ tasks: [story], existing: new Map(), mapping, render, linkEpics: true });
    expect(plan.stats.link).toBe(0);
    expect(plan.warnings[0].detail).toContain('вне выборки');
  });

  it('статус без колонки — предупреждение, а не молчаливая потеря', () => {
    const t = task({ externalId: '20260916_x', title: 'Задача', status: 'blocked' });
    const narrow: BoardMapping = { boardId: 7, columns: { backlog: 11 } };
    const plan = buildPlan({ tasks: [t], existing: new Map(), mapping: narrow, render, linkEpics: false });
    expect(plan.warnings[0].detail).toContain('нет колонки');
  });
});
