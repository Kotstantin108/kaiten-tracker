/**
 * План структуры аккаунта. Главное — повторяемость: второй прогон после
 * `--apply` не должен ничего создавать, иначе каждый запуск плодил бы
 * дубли колонок и типов в живом аккаунте. И «лишнее» не трогаем никогда.
 */
import { describe, expect, it } from 'vitest';

import { buildMapping, DESIRED, planSetup, type CurrentStructure } from '../setup-plan.js';

const empty: CurrentStructure = {
  spaces: [{ id: 1, title: 'Первое пространство' }],
  boards: [],
  cardTypes: [
    { id: 820759, name: 'Bug' },
    { id: 1, name: 'Card' },
  ],
  properties: [],
  priorityValues: [],
};

/** Аккаунт, в котором всё уже заведено, — как после `--apply`. */
function complete(): CurrentStructure {
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
    properties: [
      { id: 300, name: 'Приоритет', type: 'select' },
      { id: 301, name: 'Репозиторий', type: 'string' },
    ],
    priorityValues: DESIRED.priority.values.map((v, i) => ({ id: 400 + i, value: v })),
  };
}

describe('planSetup', () => {
  it('пустой аккаунт: пространство, доска с колонками одним запросом, 4 типа, 2 свойства, 5 вариантов', () => {
    const plan = planSetup(empty);
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === 'create-space')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'create-board')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'create-column')).toHaveLength(0);
    expect(plan.actions.filter((a) => a.kind === 'create-card-type').map((a) => (a.kind === 'create-card-type' ? a.name : ''))).toEqual([
      'Epic',
      'Story',
      'Tech',
      'Spike',
    ]);
    expect(kinds.filter((k) => k === 'create-property')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'create-select-value')).toHaveLength(5);
    expect(plan.reused).toContain('тип «Bug» (820759)');
    expect(plan.extra).toContain('тип «Card» (1)');
  });

  it('повторный прогон по заведённому аккаунту — пустой план', () => {
    expect(planSetup(complete()).actions).toEqual([]);
  });

  it('доска есть, но колонок не хватает — добавляет только недостающие, в конец, стандартные не трогает', () => {
    const current = complete();
    current.boards[0].columns = [
      { id: 1, title: 'Очередь', type: 1, sort_order: 1 },
      { id: 2, title: 'В работе', type: 2, sort_order: 2 },
    ];
    const plan = planSetup(current);
    const columns = plan.actions.flatMap((a) => (a.kind === 'create-column' ? [a] : []));
    expect(columns.map((c) => c.title)).toEqual(['Входящие', 'Бэклог', 'Готово к работе', 'Заблокировано', 'Ревью', 'Сделано', 'Отменено']);
    expect(columns[0].sortOrder).toBe(3);
    expect(plan.extra).toContain('колонка «Очередь» (1)');
  });

  it('архивное считается отсутствующим', () => {
    const current = complete();
    current.cardTypes = current.cardTypes.map((t) => (t.name === 'Epic' ? { ...t, archived: true } : t));
    expect(planSetup(current).actions).toEqual([{ kind: 'create-card-type', name: 'Epic', letter: 'E', color: 5 }]);
  });
});

describe('buildMapping', () => {
  it('собирает блок kaiten: колонки по статусам, типы, id вариантов приоритета, единственная дорожка', () => {
    const mapping = buildMapping(complete());
    expect(mapping.boardId).toBe(20);
    expect(mapping.laneId).toBe(30);
    expect(mapping.columns).toMatchObject({ inbox: 100, 'in-progress': 103, done: 106, cancelled: 107 });
    expect(mapping.types).toMatchObject({ bug: 820759, epic: 200 });
    expect(mapping.priorityProperty).toEqual({ id: 300, values: { p0: 400, p1: 401, p2: 402, p3: 403, pn: 404 } });
    expect(mapping.repoProperty).toEqual({ id: 301 });
  });

  it('неполная структура — ошибка со списком, а не маппинг с дырами', () => {
    expect(() => buildMapping(empty)).toThrow(/не хватает: доска «Задачи».*колонка «Входящие»/);
  });
});
