/**
 * План структуры аккаунта. Главное — повторяемость: второй прогон после
 * `--apply` не должен ничего создавать, иначе каждый запуск плодил бы
 * дубли колонок и типов в живом аккаунте. И «лишнее» не трогаем никогда.
 */
import { describe, expect, it } from 'vitest';

import { kaitenTemplate } from '../core/skeleton.js';
import { buildMapping, DESIRED, planSetup, withSelectValues, type CurrentStructure, type DesiredStructure } from '../setup-plan.js';

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
