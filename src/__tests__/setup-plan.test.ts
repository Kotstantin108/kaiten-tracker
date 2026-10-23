/**
 * План структуры аккаунта. Главное — повторяемость: второй прогон после
 * `--apply` не должен ничего создавать, иначе каждый запуск плодил бы
 * дубли колонок и типов в живом аккаунте. И «лишнее» не трогаем никогда.
 */
import { describe, expect, it } from 'vitest';

import { kaitenTemplate } from '../core/skeleton.js';
import { buildMapping, DEPARTMENTS, DESIRED, desiredForProject, findSpace, JUNIOR_FIELDS, planSetup, VISUAL_FIELD, withSelectValues, type CurrentStructure, type DesiredStructure } from '../setup-plan.js';

/** Схема без «Сути» и шаблонов — для тестов полей-выборов; «Суть» проверяется отдельно. */
const selectsOnly = (d: DesiredStructure): DesiredStructure => ({ ...d, summary: null, templates: false, suggested: [] });
const desired = selectsOnly(withSelectValues({ repo: ['acme-app', 'acme-site'], team: ['Разработка', 'Менеджмент'] }));

const empty: CurrentStructure = {
  spaces: [{ id: 1, title: 'Первое пространство' }],
  boards: [],
  cardTypes: [
    { id: 820759, name: 'Bug' },
    { id: 1, name: 'Card' },
  ],
  properties: [],
  selectValues: {},
};

/** Аккаунт, в котором всё уже заведено, — как после `--apply`. */
function complete(): CurrentStructure {
  const selects = [
    { id: 300, spec: desired.selects.priority },
    { id: 301, spec: desired.selects.repo },
    { id: 302, spec: desired.selects.team },
  ];
  return {
    spaces: [...empty.spaces, { id: 10, title: 'Acme' }],
    boards: [
      {
        id: 20,
        title: 'Задачи',
        columns: DESIRED.columns.map((c, i) => ({ id: 100 + i, title: c.title, type: c.type, sort_order: i + 1 })),
        lanes: [{ id: 30, title: null }],
      },
    ],
    cardTypes: [...empty.cardTypes, ...DESIRED.types.filter((t) => t.name !== 'Bug').map((t, i) => ({ id: 200 + i, name: t.name }))],
    properties: selects.map((s) => ({ id: s.id, name: s.spec.name, type: 'select' })),
    selectValues: Object.fromEntries(selects.map((s) => [s.id, s.spec.values.map((v, i) => ({ id: s.id * 10 + i, value: v }))])),
  };
}

describe('planSetup', () => {
  it('пустой аккаунт: пространство, доска с колонками одним запросом, 4 типа, 3 поля-выбора с вариантами', () => {
    const plan = planSetup(empty, desired);
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'create-space')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'create-board')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'create-column')).toHaveLength(0);
    expect(plan.actions.flatMap((a) => (a.kind === 'create-card-type' ? [a.name] : []))).toEqual(['Epic', 'Story', 'Tech', 'Spike']);
    expect(plan.actions.flatMap((a) => (a.kind === 'create-property' ? [a.name] : []))).toEqual(['Приоритет', 'Репозиторий', 'Команда']);
    expect(kinds.filter((k) => k === 'create-select-value')).toHaveLength(5 + 2 + 2);
    expect(plan.reused).toContain('тип «Bug» (820759)');
    expect(plan.extra).toContain('тип «Card» (1)');
  });

  it('повторный прогон по заведённому аккаунту — пустой план', () => {
    expect(planSetup(complete(), desired).actions).toEqual([]);
  });

  it('поле без вариантов в конфиге не заводится', () => {
    const plan = planSetup(empty, selectsOnly(withSelectValues({})));
    expect(plan.actions.flatMap((a) => (a.kind === 'create-property' ? [a.name] : []))).toEqual(['Приоритет']);
  });

  it('текстовое поле с тем же именем отключается и переименовывается, рядом заводится выбор', () => {
    const current = complete();
    current.properties = current.properties.filter((p) => p.name !== 'Репозиторий');
    current.properties.push({ id: 663468, name: 'Репозиторий', type: 'string' });
    const plan = planSetup(current, desired);
    expect(plan.actions.slice(0, 2)).toEqual([
      { kind: 'retire-property', id: 663468, name: 'Репозиторий', newName: 'Репозиторий (string, отключено)' },
      { kind: 'create-property', name: 'Репозиторий', type: 'select' },
    ]);
  });

  it('новый вариант в конфиге — досоздаётся только он', () => {
    const more = selectsOnly(withSelectValues({ repo: ['acme-app', 'acme-site', 'acme-mobile'], team: ['Разработка', 'Менеджмент'] }));
    expect(planSetup(complete(), more).actions).toEqual([{ kind: 'create-select-value', property: 'Репозиторий', value: 'acme-mobile' }]);
  });

  it('доска есть, но колонок не хватает — добавляет только недостающие, в конец, стандартные не трогает', () => {
    const current = complete();
    current.boards[0].columns = [
      { id: 1, title: 'Очередь', type: 1, sort_order: 1 },
      { id: 2, title: 'В работе', type: 2, sort_order: 2 },
    ];
    const plan = planSetup(current, desired);
    const columns = plan.actions.flatMap((a) => (a.kind === 'create-column' ? [a] : []));
    expect(columns.map((c) => c.title)).toEqual(['Входящие', 'Бэклог', 'Готово к работе', 'Заблокировано', 'Ревью', 'Сделано', 'Отменено']);
    expect(columns[0].sortOrder).toBe(3);
    expect(plan.extra).toContain('колонка «Очередь» (1)');
  });

  it('архивное считается отсутствующим', () => {
    const current = complete();
    current.cardTypes = current.cardTypes.map((t) => (t.name === 'Epic' ? { ...t, archived: true } : t));
    expect(planSetup(current, desired).actions).toEqual([{ kind: 'create-card-type', name: 'Epic', letter: 'E', color: 5 }]);
  });
});

describe('buildMapping', () => {
  it('собирает блок kaiten: колонки, типы, id вариантов всех полей-выборов, единственная дорожка', () => {
    const mapping = buildMapping(complete(), desired);
    expect(mapping.boardId).toBe(20);
    expect(mapping.laneId).toBe(30);
    expect(mapping.columns).toMatchObject({ inbox: 100, 'in-progress': 103, done: 106, cancelled: 107 });
    expect(mapping.types).toMatchObject({ bug: 820759, epic: 200 });
    expect(mapping.priorityProperty).toEqual({ id: 300, values: { p0: 3000, p1: 3001, p2: 3002, p3: 3003, pn: 3004 } });
    expect(mapping.repoProperty).toEqual({ id: 301, values: { 'acme-app': 3010, 'acme-site': 3011 } });
    expect(mapping.teamProperty).toEqual({ id: 302, values: { Разработка: 3020, Менеджмент: 3021 } });
  });

  it('неполная структура — ошибка со списком, а не маппинг с дырами', () => {
    expect(() => buildMapping(empty, desired)).toThrow(/не хватает: доска «Задачи».*колонка «Входящие»/);
  });
});

describe('шаблоны описаний и обязательная «Суть»', () => {
  const full: DesiredStructure = { ...desired, summary: { name: 'Суть' }, templates: true, suggested: ['due_date'] };

  it('без поля: завести «Суть», шаблоны и обязательность во всех пяти типах', () => {
    const plan = planSetup(complete(), full);
    expect(plan.actions.filter((a) => a.kind === 'create-property')).toEqual([{ kind: 'create-property', name: 'Суть', type: 'string' }]);
    expect(plan.actions.flatMap((a) => (a.kind === 'set-type-template' ? [a.typeName] : []))).toEqual(['Epic', 'Story', 'Tech', 'Bug', 'Spike']);
    expect(plan.actions.flatMap((a) => (a.kind === 'require-type-property' ? [a.typeName] : []))).toEqual(['Epic', 'Story', 'Tech', 'Bug', 'Spike']);
    // «Срок» — предлагается, но не обязателен.
    expect(plan.actions.flatMap((a) => (a.kind === 'suggest-type-field' ? [`${a.typeName}:${a.field}`] : []))).toEqual([
      'Epic:due_date',
      'Story:due_date',
      'Tech:due_date',
      'Bug:due_date',
      'Spike:due_date',
    ]);
  });

  it('всё заведено — пустой план; чужой шаблон перезаписывается, лишние поля типа не мешают', () => {
    const current = complete();
    current.properties.push({ id: 400, uid: 'uid-sut', name: 'Суть', type: 'string' });
    const key = (name: string) => DESIRED.types.find((t) => t.name === name)?.key ?? 'story';
    current.cardTypes = current.cardTypes.map((t) => ({
      ...t,
      description_template: kaitenTemplate(key(t.name)),
      card_properties: [
        { regular_property: 'tags', property_uid: null, sort_order: 1, required: false },
        { regular_property: null, property_uid: 'uid-sut', sort_order: -1, required: true },
        { regular_property: 'due_date', property_uid: null, sort_order: 2, required: false },
      ],
    }));
    expect(planSetup(current, full).actions).toEqual([]);

    current.cardTypes = current.cardTypes.map((t) => (t.name === 'Bug' ? { ...t, description_template: 'правка руками' } : t));
    expect(planSetup(current, full).actions).toEqual([{ kind: 'set-type-template', typeName: 'Bug', template: kaitenTemplate('bug') }]);
  });

  it('шаблон — разделы скелета с подсказками, без чекбоксов', () => {
    expect(kaitenTemplate('bug')).toContain('## Как воспроизвести');
    expect(kaitenTemplate('epic').match(/^## .+$/gm)).toEqual(['## Цель', '## Критерии-результаты']);
    expect(Object.values(DESIRED.types).some((t) => kaitenTemplate(t.key).includes('[ ]'))).toBe(false);
  });

  it('маппинг получает id поля «Суть»', () => {
    const current = complete();
    current.properties.push({ id: 400, uid: 'uid-sut', name: 'Суть', type: 'string' });
    expect(buildMapping(current, full).summaryProperty).toEqual({ id: 400 });
  });
});

describe('папка, дорожки и отделы', () => {
  const nested: DesiredStructure = {
    ...desired,
    space: 'Acme (разработка)',
    folder: 'Acme',
    knownBoardId: 20,
    lanes: { repos: { 'acme-app': 'Приложение', 'acme-site': 'Сайт' }, archive: 'Архив' },
    departments: DEPARTMENTS.filter((d) => d.key === 'marketing' || d.key === 'hr'),
  };

  /** Аккаунт до переезда: пространство разработки называется как папка и лежит наверху. */
  function before(): CurrentStructure {
    const current = complete();
    current.spaces = [...empty.spaces, { id: 10, uid: 'uid-dev', title: 'Acme', parent_entity_uid: null, boards: [{ id: 20 }] }];
    current.boards[0].lanes = [{ id: 30, title: '', sort_order: 1 }, { id: 31, title: 'Приложение', sort_order: 2 }];
    return current;
  }

  it('до переезда: папка, переименовать и перенести, недостающие дорожки, отделы', () => {
    const plan = planSetup(before(), nested);
    expect(plan.actions).toEqual([
      { kind: 'create-folder', title: 'Acme' },
      { kind: 'move-space', id: 10, from: 'Acme', title: 'Acme (разработка)', folder: 'Acme' },
      { kind: 'create-lane', title: 'Сайт', sortOrder: 3 },
      { kind: 'create-lane', title: 'Архив', sortOrder: 4 },
      { kind: 'create-department', space: 'Маркетинг', board: 'Задачи', columns: DEPARTMENTS[0].columns.map((c) => ({ ...c })) },
      { kind: 'create-department', space: 'HR', board: 'Найм', columns: DEPARTMENTS[1].columns.map((c) => ({ ...c })) },
    ]);
  });

  /** После `--apply`. */
  function after(): CurrentStructure {
    const current = before();
    current.spaces = [
      ...empty.spaces,
      { id: 9, uid: 'uid-folder', title: 'Acme', parent_entity_uid: null },
      { id: 10, uid: 'uid-dev', title: 'Acme (разработка)', parent_entity_uid: 'uid-folder', boards: [{ id: 20 }] },
      { id: 11, uid: 'uid-m', title: 'Маркетинг', parent_entity_uid: 'uid-folder' },
      { id: 12, uid: 'uid-h', title: 'HR', parent_entity_uid: 'uid-folder' },
      // Одноимённый отдел в чужой папке — не наш.
      { id: 13, uid: 'uid-x', title: 'Маркетинг', parent_entity_uid: 'uid-other' },
    ];
    current.boards[0].lanes.push({ id: 32, title: 'Сайт', sort_order: 3 }, { id: 33, title: 'Архив', sort_order: 4 });
    return current;
  }

  it('после --apply — пустой план', () => {
    expect(planSetup(after(), nested).actions).toEqual([]);
  });

  it('папка пространства токену не видна — ни второй папки, ни переноса, ни отделов; переименование — без папки', () => {
    const current = after();
    current.spaces = current.spaces.filter((s) => s.uid !== 'uid-folder');
    expect(planSetup(current, nested).actions).toEqual([]);
    expect(planSetup(current, { ...nested, space: 'Разработка' }).actions).toEqual([{ kind: 'move-space', id: 10, from: 'Acme (разработка)', title: 'Разработка' }]);
  });

  describe('одно имя пространства в двух проектах', () => {
    /** Acme и Globex: «Разработка» в каждой папке; Acme ещё не переименован. */
    function twoProjects(): CurrentStructure {
      const current = after();
      current.spaces = [
        ...empty.spaces,
        { id: 9, uid: 'uid-folder', title: 'Acme', parent_entity_uid: null },
        { id: 10, uid: 'uid-dev', title: 'Acme (разработка)', parent_entity_uid: 'uid-folder', boards: [{ id: 20 }] },
        { id: 11, uid: 'uid-m', title: 'Маркетинг', parent_entity_uid: 'uid-folder' },
        { id: 12, uid: 'uid-h', title: 'HR', parent_entity_uid: 'uid-folder' },
        { id: 40, uid: 'uid-globex', title: 'Globex', parent_entity_uid: null },
        { id: 41, uid: 'uid-globex-dev', title: 'Разработка', parent_entity_uid: 'uid-globex', boards: [{ id: 50 }] },
      ];
      return current;
    }
    const renamed: DesiredStructure = { ...nested, space: 'Разработка' };

    it('по доске проекта: переименовать своё, чужое не трогать', () => {
      expect(findSpace(twoProjects(), renamed)?.id).toBe(10);
      expect(planSetup(twoProjects(), renamed).actions).toEqual([{ kind: 'move-space', id: 10, from: 'Acme (разработка)', title: 'Разработка', folder: 'Acme' }]);
    });

    it('без доски — по имени только в своей папке', () => {
      const { knownBoardId: _known, ...fresh } = renamed;
      expect(findSpace(twoProjects(), fresh)).toBeUndefined();
      expect(planSetup(twoProjects(), fresh).actions).toContainEqual({ kind: 'create-space', title: 'Разработка' });
      expect(planSetup(twoProjects(), fresh).actions.some((a) => a.kind === 'move-space')).toBe(false);
    });

    it('без папки — вложенное с таким именем, только если оно одно', () => {
      const { folder: _folder, departments: _d, knownBoardId: _k, ...flat } = renamed;
      const current = twoProjects();
      expect(findSpace(current, { ...flat, departments: [] })?.id).toBe(41);
      current.spaces.push({ id: 42, uid: 'uid-dev-2', title: 'Разработка', parent_entity_uid: 'uid-folder' });
      expect(findSpace(current, { ...flat, departments: [] })).toBeUndefined();
    });
  });

  it('маппинг: дорожки продуктов, «Архив» и дорожка по умолчанию', () => {
    const mapping = buildMapping(after(), nested);
    expect(mapping).toMatchObject({ laneId: 30, repoLanes: { 'acme-app': 31, 'acme-site': 32 }, archiveLaneId: 33 });
  });

  it('несколько дорожек, а в схеме их нет, — дорожку по умолчанию не угадываем', () => {
    expect(buildMapping(after(), desired).laneId).toBeUndefined();
  });

  it('конфиг: неизвестный отдел и отделы без папки — ошибка', () => {
    const base = { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий', repoLabels: [], teams: [] };
    expect(() => desiredForProject({ ...base, folder: 'Acme', departments: ['legal'] })).toThrow(/Нет шаблона отдела: legal/);
    expect(() => desiredForProject({ ...base, departments: ['hr'] })).toThrow(/kaiten.folder/);
  });
});

describe('поля «Можно младшему»', () => {
  const withJunior: DesiredStructure = { ...desired, junior: JUNIOR_FIELDS };

  /** Всё заведено: оба поля с вариантами и в типах Story, Tech, Bug. */
  function ready(): CurrentStructure {
    const current = complete();
    current.properties.push(
      { id: 500, uid: 'uid-junior', name: 'Можно младшему', type: 'select' },
      { id: 501, uid: 'uid-missing', name: 'Младшему не хватает', type: 'string' },
      { id: 502, uid: 'uid-assess', name: 'Оценка', type: 'select' },
    );
    current.selectValues[500] = [
      { id: 5000, value: 'Да' },
      { id: 5001, value: 'Нет' },
    ];
    current.selectValues[502] = [
      { id: 5020, value: 'Актуальна' },
      { id: 5021, value: 'Похоже, сделана' },
      { id: 5022, value: 'Похоже, устарела' },
    ];
    current.cardTypes = current.cardTypes.map((t) =>
      ['Story', 'Tech', 'Bug'].includes(t.name)
        ? {
            ...t,
            card_properties: [
              { regular_property: null, property_uid: 'uid-junior', sort_order: 5, required: false },
              { regular_property: null, property_uid: 'uid-missing', sort_order: 6, required: false },
              { regular_property: null, property_uid: 'uid-assess', sort_order: 7, required: false },
            ],
          }
        : t,
    );
    return current;
  }

  it('без блока junior в конфиге — полей нет ни в плане, ни в маппинге', () => {
    expect(planSetup(complete(), desired).actions).toEqual([]);
    expect(buildMapping(ready(), desired)).not.toHaveProperty('juniorProperty');
  });

  it('с блоком: три поля, варианты Да/Нет и оценки, необязательно в Story, Tech, Bug — не в Epic и Spike', () => {
    const plan = planSetup(complete(), withJunior);
    expect(plan.actions).toEqual([
      { kind: 'create-property', name: 'Можно младшему', type: 'select' },
      { kind: 'create-property', name: 'Младшему не хватает', type: 'string' },
      { kind: 'create-property', name: 'Оценка', type: 'select' },
      { kind: 'create-select-value', property: 'Можно младшему', value: 'Да' },
      { kind: 'create-select-value', property: 'Можно младшему', value: 'Нет' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Актуальна' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Похоже, сделана' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Похоже, устарела' },
      ...['Story', 'Tech', 'Bug'].flatMap((typeName) => [
        { kind: 'add-type-property', typeName, property: 'Можно младшему', propertyType: 'select' },
        { kind: 'add-type-property', typeName, property: 'Младшему не хватает', propertyType: 'string' },
        { kind: 'add-type-property', typeName, property: 'Оценка', propertyType: 'select' },
      ]),
    ]);
  });

  it('этап 1 уже заведён — план добавляет только «Оценку»', () => {
    const current = ready();
    current.properties = current.properties.filter((p) => p.id !== 502);
    delete current.selectValues[502];
    current.cardTypes = current.cardTypes.map((t) => ({ ...t, card_properties: (t.card_properties ?? []).filter((p) => p.property_uid !== 'uid-assess') }));
    expect(planSetup(current, withJunior).actions).toEqual([
      { kind: 'create-property', name: 'Оценка', type: 'select' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Актуальна' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Похоже, сделана' },
      { kind: 'create-select-value', property: 'Оценка', value: 'Похоже, устарела' },
      ...['Story', 'Tech', 'Bug'].map((typeName) => ({ kind: 'add-type-property', typeName, property: 'Оценка', propertyType: 'select' })),
    ]);
  });

  it('всё заведено — пустой план; поле пропало из типа — возвращается только оно', () => {
    expect(planSetup(ready(), withJunior).actions).toEqual([]);
    const current = ready();
    current.cardTypes = current.cardTypes.map((t) => (t.name === 'Tech' ? { ...t, card_properties: [] } : t));
    expect(planSetup(current, withJunior).actions).toEqual([
      { kind: 'add-type-property', typeName: 'Tech', property: 'Можно младшему', propertyType: 'select' },
      { kind: 'add-type-property', typeName: 'Tech', property: 'Младшему не хватает', propertyType: 'string' },
      { kind: 'add-type-property', typeName: 'Tech', property: 'Оценка', propertyType: 'select' },
    ]);
  });

  it('одноимённое поле другого типа отключается, рядом заводится нужное', () => {
    const current = ready();
    current.properties = current.properties.map((p) => (p.id === 501 ? { ...p, type: 'select' } : p));
    expect(planSetup(current, withJunior).actions.slice(0, 2)).toEqual([
      { kind: 'retire-property', id: 501, name: 'Младшему не хватает', newName: 'Младшему не хватает (select, отключено)' },
      { kind: 'create-property', name: 'Младшему не хватает', type: 'string' },
    ]);
  });

  it('маппинг: id выбора с вариантами yes/no и id строки; чего-то нет — ошибка', () => {
    expect(buildMapping(ready(), withJunior)).toMatchObject({
      juniorProperty: { id: 500, values: { yes: 5000, no: 5001 } },
      juniorMissingProperty: { id: 501 },
      assessProperty: { id: 502, values: { actual: 5020, done: 5021, obsolete: 5022 } },
    });
    const current = ready();
    current.selectValues[500] = [{ id: 5000, value: 'Да' }];
    expect(() => buildMapping(current, withJunior)).toThrow(/вариант «Нет» поля «Можно младшему»/);
    expect(() => buildMapping(complete(), withJunior)).toThrow(/поле-выбор «Можно младшему».*поле «Младшему не хватает»/);
  });

  it('конфиг: junior — поля в схеме проекта', () => {
    const base = { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий', repoLabels: [], teams: [] };
    expect(desiredForProject(base).junior).toBeNull();
    expect(desiredForProject({ ...base, junior: true }).junior).toEqual(JUNIOR_FIELDS);
  });
});

describe('поле «Было / Стало»', () => {
  const withVisual: DesiredStructure = { ...desired, visual: VISUAL_FIELD };

  function ready(): CurrentStructure {
    const current = complete();
    current.properties.push({ id: 600, uid: 'uid-visual', name: 'Было / Стало', type: 'select' });
    current.selectValues[600] = [
      { id: 6000, value: 'Есть' },
      { id: 6001, value: 'Нет визуальных изменений' },
    ];
    current.cardTypes = current.cardTypes.map((t) =>
      ['Story', 'Tech', 'Bug'].includes(t.name) ? { ...t, card_properties: [{ regular_property: null, property_uid: 'uid-visual', sort_order: 8, required: false }] } : t,
    );
    return current;
  }

  it('без блока visual — поля нет ни в плане, ни в маппинге', () => {
    expect(planSetup(complete(), desired).actions).toEqual([]);
    expect(buildMapping(ready(), desired)).not.toHaveProperty('visualProperty');
  });

  it('с блоком: выбор «Есть» / «Нет визуальных изменений», необязательно в Story, Tech, Bug', () => {
    expect(planSetup(complete(), withVisual).actions).toEqual([
      { kind: 'create-property', name: 'Было / Стало', type: 'select' },
      { kind: 'create-select-value', property: 'Было / Стало', value: 'Есть' },
      { kind: 'create-select-value', property: 'Было / Стало', value: 'Нет визуальных изменений' },
      ...['Story', 'Tech', 'Bug'].map((typeName) => ({ kind: 'add-type-property', typeName, property: 'Было / Стало', propertyType: 'select' })),
    ]);
  });

  it('заведено — пустой план и маппинг yes/no; варианта нет — ошибка', () => {
    expect(planSetup(ready(), withVisual).actions).toEqual([]);
    expect(buildMapping(ready(), withVisual)).toMatchObject({ visualProperty: { id: 600, values: { yes: 6000, no: 6001 } } });
    const current = ready();
    current.selectValues[600] = [{ id: 6000, value: 'Есть' }];
    expect(() => buildMapping(current, withVisual)).toThrow(/вариант «Нет визуальных изменений» поля «Было \/ Стало»/);
  });

  it('конфиг: visual — поле в схеме проекта', () => {
    const base = { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий', repoLabels: [], teams: [] };
    expect(desiredForProject(base).visual).toBeNull();
    expect(desiredForProject({ ...base, visual: true }).visual).toEqual(VISUAL_FIELD);
  });
});
