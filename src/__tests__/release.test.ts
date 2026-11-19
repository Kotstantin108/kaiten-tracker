/**
 * Журнал выкаток — чистая часть: формат времени, разбор строк изменений,
 * страница ⇄ строки, копия записи в теге, версии, «что не записано».
 */
import { describe, expect, it } from 'vitest';

import { ProjectSchema, releaseSetting } from '../config.js';
import {
  APPROX,
  calendarVersion,
  chooseTime,
  COLUMNS,
  FRESH_MS,
  mergedBranch,
  mergeRows,
  NONE,
  overdue,
  pageNodes,
  parseChanges,
  parseRecordMessage,
  readPage,
  recordMessage,
  recordTagName,
  releaseTime,
  rowsOf,
  uncoveredTasks,
  versionProblem,
  type DeployFacts,
  type ReleaseRecord,
} from '../core/release.js';

const DICT = { zones: ['пейволл', 'онбординг', 'прочее'], types: ['новое', 'исправление', 'техническое'] };
const known = (ref: string): { ref: string } | { error: string } => (ref === 'PRJ-1' || ref === 'pay-flow' ? { ref: 'PRJ-1' } : { error: `нет задачи ${ref}` });

const RELEASE: ReleaseRecord = {
  surface: 'продукт',
  version: 'v1.1.0',
  event: 'релиз',
  at: '2026-11-19T12:00+03:00',
  approx: false,
  commit: 'a'.repeat(40),
  changes: [
    { task: 'PRJ-1', zone: 'пейволл', type: 'новое', text: 'Цена *годового* тарифа видна до оплаты [см. макет](x)' },
    { task: null, zone: 'прочее', type: 'техническое', text: 'Обновление зависимостей' },
  ],
};

describe('время записи', () => {
  it('по Москве, до минуты, со смещением', () => {
    expect(releaseTime(new Date('2026-11-10T15:42:59Z'))).toBe('2026-11-10T18:42+03:00');
    expect(releaseTime(new Date('2026-12-31T22:05:00Z'))).toBe('2027-01-01T01:05+03:00');
  });
});

describe('строки изменений', () => {
  it('разбираются: задача по любому её имени, словари без учёта регистра, пустые строки и # пропущены', () => {
    const parsed = parseChanges('# что вышло\n\npay-flow | Пейволл | НОВОЕ | Цена видна до оплаты\n- | прочее | техническое | Обновление зависимостей\r\n', DICT, known);
    expect(parsed.problems).toEqual([]);
    expect(parsed.changes).toEqual([
      { task: 'PRJ-1', zone: 'пейволл', type: 'новое', text: 'Цена видна до оплаты' },
      { task: null, zone: 'прочее', type: 'техническое', text: 'Обновление зависимостей' },
    ]);
  });

  it('все замечания — разом, с номером строки и словарём', () => {
    const parsed = parseChanges('PRJ-9 | оплата | фича | Текст\nбез частей\n- | прочее | новое |\n', DICT, known);
    expect(parsed.changes).toEqual([]);
    expect(parsed.problems).toEqual([
      'строка 1: нет задачи PRJ-9',
      'строка 1: нет зоны «оплата». Можно: пейволл, онбординг, прочее',
      'строка 1: нет типа «фича». Можно: новое, исправление, техническое',
      'строка 2: нужно четыре части через «|» — задача | зона | тип | что изменилось (в тексте «|» нельзя)',
      'строка 3: не сказано, что изменилось',
    ]);
  });

  it('пустой ввод — отказ, а не пустая запись', () => {
    expect(parseChanges('\n# только заметка\n', DICT, known).problems).toEqual(['нет ни одной строки изменений']);
  });

  it('задача выкатки без строки — названа', () => {
    expect(uncoveredTasks(RELEASE.changes, ['PRJ-1', 'PRJ-2'])).toEqual(['PRJ-2']);
  });
});

describe('страница журнала', () => {
  it('строки записи: поля выкатки — в каждой, изменение без задачи — с прочерком', () => {
    expect(rowsOf(RELEASE)).toEqual([
      { at: '2026-11-19T12:00+03:00', surface: 'продукт', version: 'v1.1.0', event: 'релиз', zone: 'пейволл', type: 'новое', task: 'PRJ-1', text: RELEASE.changes[0].text },
      { at: '2026-11-19T12:00+03:00', surface: 'продукт', version: 'v1.1.0', event: 'релиз', zone: 'прочее', type: 'техническое', task: NONE, text: 'Обновление зависимостей' },
    ]);
  });

  it('откат — одна строка с причиной, приблизительное время — с пометкой', () => {
    expect(rowsOf({ ...RELEASE, event: 'откат', approx: true, changes: [], reason: 'Не проходит оплата' })).toEqual([
      { at: `${APPROX}2026-11-19T12:00+03:00`, surface: 'продукт', version: 'v1.1.0', event: 'откат', zone: NONE, type: NONE, task: NONE, text: 'Не проходит оплата' },
    ]);
  });

  it('записанное читается обратно дословно: разметка в тексте остаётся текстом', () => {
    const rows = rowsOf(RELEASE);
    const nodes = pageNodes(rows);
    expect(nodes[1].content?.[0].content?.map((c) => c.content?.[0].content?.[0].text)).toEqual([...COLUMNS]);
    expect(nodes[1].content?.[1].content?.[7].content?.[0].content).toEqual([{ type: 'text', text: RELEASE.changes[0].text }]);
    expect(readPage(nodes)).toEqual({ state: 'ok', rows });
  });

  it('пустая страница и страница с пустыми абзацами — журнал не начат', () => {
    expect(readPage([])).toEqual({ state: 'empty' });
    expect(readPage([{ type: 'paragraph' }])).toEqual({ state: 'empty' });
    expect(readPage(pageNodes([]))).toEqual({ state: 'ok', rows: [] });
  });

  it('хвост из пустого абзаца, который дописывает редактор, страницу не портит', () => {
    expect(readPage([...pageNodes(rowsOf(RELEASE)), { type: 'paragraph' }]).state).toBe('ok');
  });

  it('две таблицы — повреждена; строки читаются один раз', () => {
    const nodes = pageNodes(rowsOf(RELEASE));
    const page = readPage([...nodes, ...nodes]);
    expect(page).toMatchObject({ state: 'broken', problem: expect.stringContaining('2 таблицы вместо одной') });
    expect(page.state === 'broken' && page.salvaged).toEqual(rowsOf(RELEASE));
  });

  it('чужое содержимое, изменённая шапка и битая строка — повреждена', () => {
    const [notice, table] = pageNodes(rowsOf(RELEASE));
    expect(readPage([notice, table, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Заметки' }] }])).toMatchObject({ state: 'broken', problem: 'после таблицы журнала есть другое содержимое' });
    expect(readPage([{ type: 'paragraph', content: [{ type: 'text', text: 'Мои заметки' }] }, table])).toMatchObject({ state: 'broken', problem: 'страница начинается не с пометки журнала' });
    expect(readPage([{ type: 'paragraph', content: [{ type: 'text', text: 'Просто текст' }] }])).toMatchObject({ state: 'broken', problem: 'на странице нет таблицы журнала' });
    const renamed = structuredClone(table);
    if (renamed.content?.[0].content?.[4].content?.[0].content?.[0]) renamed.content[0].content[4].content[0].content[0].text = 'Раздел';
    expect(readPage([notice, renamed])).toMatchObject({ state: 'broken', problem: 'шапка таблицы изменена' });
    const cut = structuredClone(table);
    cut.content?.[1].content?.pop();
    const page = readPage([notice, cut]);
    expect(page).toMatchObject({ state: 'broken', problem: expect.stringContaining('не читаются: 1') });
    expect(page.state === 'broken' && page.salvaged).toHaveLength(1);
  });

  it('новые записи — сверху, строки записи — вместе; запись с тем же ключом заменяет прежнюю', () => {
    const old = rowsOf({ ...RELEASE, version: 'v1.0.0', at: '2026-10-01T10:00+03:00', approx: true });
    const landing = rowsOf({ ...RELEASE, surface: 'лендинг', version: '2026.11.19.1', at: '2026-11-19T12:30+03:00', changes: [RELEASE.changes[1]] });
    const merged = mergeRows([...rowsOf(RELEASE), ...old], landing);
    expect(merged.map((r) => r.version)).toEqual(['2026.11.19.1', 'v1.1.0', 'v1.1.0', 'v1.0.0', 'v1.0.0']);
    const fixed = rowsOf({ ...RELEASE, changes: [RELEASE.changes[1]] });
    expect(mergeRows(merged, fixed).map((r) => r.version)).toEqual(['2026.11.19.1', 'v1.1.0', 'v1.0.0', 'v1.0.0']);
  });
});

describe('копия записи в теге', () => {
  it('запись читается из аннотации дословно', () => {
    const message = recordMessage(RELEASE);
    expect(message.split('\n')[0]).toBe('Релиз v1.1.0 — продукт');
    expect(parseRecordMessage(message)).toEqual(RELEASE);
  });

  it('чужая аннотация и битая запись — не запись', () => {
    expect(parseRecordMessage('Release v1.1.0 — соляр')).toBeNull();
    expect(parseRecordMessage('Релиз\n\nkaiten-release: {"v":1,"surface":"продукт"}')).toBeNull();
    expect(parseRecordMessage('Релиз\n\nkaiten-release: не json')).toBeNull();
  });

  it('имя тега: релиз — по версии, откаты одной версии — с номером', () => {
    expect(recordTagName(RELEASE, new Set())).toBe('released/v1.1.0');
    expect(recordTagName({ ...RELEASE, event: 'откат' }, new Set())).toBe('released/v1.1.0-rollback');
    expect(recordTagName({ ...RELEASE, event: 'откат' }, new Set(['released/v1.1.0-rollback', 'released/v1.1.0-rollback-2']))).toBe('released/v1.1.0-rollback-3');
  });
});

describe('версии и ветки', () => {
  it('календарная версия — день по Москве и номер выкатки за день', () => {
    const at = new Date('2026-11-19T21:30:00Z');
    expect(calendarVersion(at, [])).toBe('2026.11.20.1');
    expect(calendarVersion(at, ['2026.11.20.1', '2026.11.20.3', '2026.11.19.7', 'v1.0.0'])).toBe('2026.11.20.4');
  });

  it('версия годится в имя тега', () => {
    expect(versionProblem('v1.2.3')).toBeNull();
    expect(versionProblem('2026.11.19.1')).toBeNull();
    for (const bad of ['v1 2', 'a/b', '-x', 'v1..2', 'v1.', 'x.lock']) expect(versionProblem(bad)).not.toBeNull();
  });

  it('влитая ветка — из сообщения merge-коммита', () => {
    expect(mergedBranch("Merge branch 'feature/101-pay'")).toBe('feature/101-pay');
    expect(mergedBranch("Merge branch 'main' into production")).toBe('main');
    expect(mergedBranch("Merge remote-tracking branch 'origin/main' into feature/x")).toBe('main');
    expect(mergedBranch('Merge pull request #23 from acme/feature/101-pay')).toBe('feature/101-pay');
    expect(mergedBranch('merge(main): правки')).toBeNull();
  });
});

describe('что не записано', () => {
  const now = new Date('2026-11-19T12:00:00+03:00');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const tag = (taggedAt: Date): DeployFacts['recorded'][number] => ({ tag: 'released/v1.0.0', commit: 'c', taggedAt, record: RELEASE });

  it('журнал не начат — работу ничего не держит', () => {
    expect(overdue({ recorded: [], pending: [{ commit: 'a', time: ago(10 * FRESH_MS) }], rolledBack: null }, now)).toEqual([]);
  });

  it('держит выкатка после начала журнала, когда «только что» прошло; история и свежая — нет', () => {
    const history = { version: 'v0.9.0', commit: 'h', time: ago(30 * FRESH_MS) };
    const missed = { version: 'v1.1.0', commit: 'm', time: ago(2 * FRESH_MS) };
    const fresh = { version: 'v1.2.0', commit: 'f', time: ago(FRESH_MS / 2) };
    expect(overdue({ recorded: [tag(ago(20 * FRESH_MS))], pending: [history, missed, fresh], rolledBack: null }, now)).toEqual([missed]);
  });

  it('время: свежей — момент запуска; давней — только по явному выбору', () => {
    const fresh = { commit: 'f', time: ago(FRESH_MS / 2) };
    const old = { commit: 'o', time: new Date('2026-11-10T18:42:10+03:00') };
    expect(chooseTime(fresh, now, { missed: false, now: false })).toEqual({ at: '2026-11-19T12:00+03:00', approx: false });
    expect(chooseTime(old, now, { missed: true, now: false })).toEqual({ at: '2026-11-10T18:42+03:00', approx: true });
    expect(chooseTime(old, now, { missed: false, now: true })).toEqual({ at: '2026-11-19T12:00+03:00', approx: false });
    expect(chooseTime(old, now, { missed: false, now: false })).toMatchObject({ problem: expect.stringContaining('--missed') });
    expect(chooseTime(old, now, { missed: true, now: true })).toMatchObject({ problem: expect.stringContaining('вместе не ставят') });
  });
});

describe('настройки проекта', () => {
  const base = { title: 'Acme', kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' } };
  const releases = { page: 'abc', zones: ['пейволл'], types: ['новое'] };

  it('журнал — у репозитория с release; остальным говорят, кто его ведёт', () => {
    const project = ProjectSchema.parse({ ...base, releases, repos: [{ name: 'acme-app', label: 'A', release: { surface: 'продукт', versions: 'tags' } }, { name: 'acme-crm', label: 'C' }] });
    expect(releaseSetting(project, 'acme-app')).toEqual({ state: 'on', page: 'abc', zones: ['пейволл'], types: ['новое'], repo: { surface: 'продукт', branch: 'production', versions: 'tags', tagPrefix: 'v' } });
    expect(releaseSetting(project, 'acme-crm')).toEqual({ state: 'other-repo', surfaces: ['продукт — acme-app'] });
    expect(releaseSetting(ProjectSchema.parse({ ...base, repos: [{ name: 'acme-app', label: 'A' }] }), 'acme-app')).toEqual({ state: 'off' });
  });

  it('release без журнала проекта, одна поверхность у двух репозиториев и повтор в словаре — отказ', () => {
    const issues = (config: object): string[] => {
      const parsed = ProjectSchema.safeParse(config);
      return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
    };
    expect(issues({ ...base, repos: [{ name: 'acme-app', label: 'A', release: { surface: 'продукт', versions: 'tags' } }] })).toEqual(['выкатки репозитория заданы, а журнала выкаток у проекта нет — добавьте releases']);
    expect(
      issues({ ...base, releases, repos: [{ name: 'a', label: 'A', release: { surface: 'Продукт', versions: 'tags' } }, { name: 'b', label: 'B', release: { surface: 'продукт', versions: 'calendar' } }] }),
    ).toEqual(['поверхность «продукт» уже у репозитория a']);
    expect(issues({ ...base, releases: { ...releases, zones: ['пейволл', 'Пейволл'] }, repos: [{ name: 'a', label: 'A' }] })).toEqual(['«Пейволл» названо дважды']);
  });
});
