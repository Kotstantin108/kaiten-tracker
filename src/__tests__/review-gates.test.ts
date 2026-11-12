/**
 * Гейты сдачи — чистая часть: пути документации, свидетельство прогона,
 * тексты отказов, операция `verify`, раздел «Как проверить», домен в формате
 * задачи. Сквозной прогон с git — `review-gates-cli.test.ts`.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { domainProblem, domainsOf, projectFromTasksRepo, reviewGates, testPlanRequired } from '../config.js';
import { contentHash, parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { fileProperties } from '../core/kaiten-sync-plan.js';
import { checksGateProblem, docsDecision, docsTouched, evidenceCovers, formatDuration, gatesApply, globToRegExp, outputTail, verifyEntry, type CheckResult } from '../core/review-gates.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { newBodyProblems, newBodyTemplate, withTestPlanTemplate, withTestPlanWaiver } from '../core/skeleton.js';
import { applyOp, hasWorkNote, tasksOf, type Op, type TaskTexts } from '../core/task-ops.js';
import { domainLine, formatShow, formatTaskLines, taskJson } from '../kaiten-format.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const PATH = 'active/export-orders.md';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const CTX = { date: '2026-11-12', stamp: '2026-11-12 10:15:00 +03:00', by: 'alice' };

function file(fm: Partial<Frontmatter> = {}, body = '\n## Критерии готовности\n\n- [x] Выгрузка работает\n'): string {
  return serializeTaskDocument(
    FrontmatterSchema.parse({
      id: ID,
      tracker: '600',
      title: 'Выгрузить заказы в отчёт',
      summary: 'Отчёт по заказам за месяц.',
      type: 'story',
      status: 'in-progress',
      repo: 'acme-app',
      created: '2026-11-01',
      created_by: 'alice',
      updated: '2026-11-01',
      ...fm,
    }),
    body,
  );
}

const fmOf = (text: string | undefined): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);

function apply(texts: Map<string, string>, op: Op): void {
  const r = applyOp(op, texts as TaskTexts, CTX);
  if ('error' in r) throw new Error(r.error);
  for (const c of r.changes) {
    if (c.text === null) texts.delete(c.path);
    else texts.set(c.path, c.text);
  }
}

const passed: CheckResult[] = [
  { name: 'typecheck', outcome: 'passed', ms: 12_300 },
  { name: 'test', outcome: 'passed', ms: 185_000 },
];
const failed: CheckResult[] = [
  { name: 'typecheck', outcome: 'passed', ms: 400 },
  { name: 'lint', outcome: 'failed', ms: 3_000 },
  { name: 'test', outcome: 'skipped', ms: 0 },
];

const CONFIG = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [
    { name: 'acme-app', label: 'Acme-app' },
    { name: 'acme-site', label: 'Acme-site', branch: 'master', review: { checks: [{ name: 'build', run: 'npm run build' }] } },
  ],
};
const load = (extra: Record<string, unknown> = {}) => projectFromTasksRepo(JSON.stringify({ ...CONFIG, ...extra })).project;

describe('настройки проекта', () => {
  it('без review и domains гейтов и доменов нет', () => {
    const project = load();
    expect(reviewGates(project, 'acme-app')).toEqual({ checks: [], docs: [], mainBranch: 'main' });
    expect(testPlanRequired(project)).toBe(false);
    expect(domainsOf(project)).toBeNull();
    expect(domainProblem(project, undefined)).toBeNull();
    expect(domainProblem(project, 'core')).toContain('домены задач не ведутся');
  });

  it('проверки и документация — общие, а у репозитория со своими — свои', () => {
    const project = load({ review: { checks: [{ name: 'typecheck', run: 'npm run typecheck' }, { name: 'test', run: 'npm test', timeoutMin: 5 }], docs: ['docs/**'], testPlan: true } });
    const app = reviewGates(project, 'acme-app');
    expect(app.checks.map((c) => [c.name, c.run, c.timeoutMin])).toEqual([
      ['typecheck', 'npm run typecheck', 30],
      ['test', 'npm test', 5],
    ]);
    expect(app.docs).toEqual(['docs/**']);
    const site = reviewGates(project, 'acme-site');
    expect(site.checks.map((c) => c.name)).toEqual(['build']);
    // Пути документации у репозитория не заданы — общие.
    expect(site.docs).toEqual(['docs/**']);
    expect(site.mainBranch).toBe('master');
    expect(testPlanRequired(project)).toBe(true);
  });

  it('что в настройках отклоняется: повтор имени, пустая команда, незнакомый ключ, имя домена не латиницей', () => {
    expect(() => load({ review: { checks: [{ name: 'test', run: 'a' }, { name: 'test', run: 'b' }] } })).toThrow(/названа дважды/);
    expect(() => load({ review: { checks: [{ name: 'test', run: '  ' }] } })).toThrow(/пустая команда/);
    expect(() => load({ review: { cheks: [] } })).toThrow();
    expect(() => load({ domains: { 'Ядро': 'читать целиком' } })).toThrow(/имя домена/);
  });

  it('домен проверяется по списку проекта, отказ называет допустимые', () => {
    const project = load({ domains: { core: 'человек читает изменения целиком', supporting: 'автор и гейты', generic: 'пролистать после гейтов' } });
    expect(domainProblem(project, 'core')).toBeNull();
    expect(domainProblem(project, 'billing')).toBe('нет домена «billing». Можно: core, supporting, generic');
  });
});

describe('пути документации', () => {
  it('* — внутри папки, ** — через папки, в том числе ни одной', () => {
    expect(globToRegExp('docs/**').test('docs/api/auth.md')).toBe(true);
    expect(globToRegExp('docs/**').test('src/docs/a.md')).toBe(false);
    expect(globToRegExp('**/README.md').test('README.md')).toBe(true);
    expect(globToRegExp('**/README.md').test('packages/api/README.md')).toBe(true);
    expect(globToRegExp('**/README.md').test('packages/api/README.md.bak')).toBe(false);
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/api/a.md')).toBe(false);
    expect(globToRegExp('src/**/notes.txt').test('src/notes.txt')).toBe(true);
    // Точка в шаблоне — точка, а не «любой знак».
    expect(globToRegExp('CHANGELOG.md').test('CHANGELOGxmd')).toBe(false);
  });

  it('папка без звёздочек — всё, что в ней', () => {
    expect(docsTouched(['docs/api/auth.md', 'src/a.ts', 'wiki/x.md'], ['docs', 'wiki/'])).toEqual(['docs/api/auth.md', 'wiki/x.md']);
    expect(docsTouched(['src/docs.ts'], ['docs'])).toEqual([]);
  });

  const base = { ref: 'PRJ-1', globs: ['docs/**', '**/README.md'], mainBranch: 'main' };

  it('правка документации в ветке — принято, в журнал — что именно', () => {
    expect(docsDecision({ ...base, changed: ['src/a.ts', 'docs/a.md', 'README.md', 'docs/b.md', 'docs/c.md'] })).toEqual({ note: 'документация: docs/a.md, README.md, docs/b.md и ещё 1' });
  });

  it('правок нет — отказ с обоими выходами: обновить страницу модуля или назвать причину', () => {
    const decision = docsDecision({ ...base, changed: ['src/a.ts'] });
    expect('problem' in decision && decision.problem).toContain('Обновите страницу модуля');
    expect('problem' in decision && decision.problem).toContain('kaiten review PRJ-1 --no-ingest "<почему>"');
    expect('problem' in decision && decision.problem).toContain('docs/**, **/README.md');
  });

  it('--no-ingest с причиной — принято, причина в журнал; без причины и при правленой документации — отказ', () => {
    expect(docsDecision({ ...base, changed: ['src/a.ts'], noIngest: ' правка опечатки ' })).toEqual({ note: 'документация не обновлена: правка опечатки' });
    expect(docsDecision({ ...base, changed: ['src/a.ts'], noIngest: '  ' })).toEqual({ problem: '--no-ingest: напишите, почему документация не меняется' });
    const both = docsDecision({ ...base, changed: ['docs/a.md'], noIngest: 'не нужна' });
    expect('problem' in both && both.problem).toContain('уберите флаг');
  });

  it('основной ветки нет — отказ называет, как её получить; причина словами проходит и так', () => {
    const decision = docsDecision({ ...base, changed: null });
    expect('problem' in decision && decision.problem).toContain('git fetch origin main');
    expect(docsDecision({ ...base, changed: null, noIngest: 'только сценарий n8n' })).toEqual({ note: 'документация не обновлена: только сценарий n8n' });
  });
});

describe('свидетельство прогона', () => {
  const wanted = ['typecheck', 'test'];
  const gate = (over: Partial<Parameters<typeof checksGateProblem>[0]>) => checksGateProblem({ ref: 'PRJ-1', head: HEAD, dirty: false, wanted, ...over });

  it('успешный прогон всех проверок на текущем коммите — принято', () => {
    const evidence = { commit: HEAD, passed: true, names: ['typecheck', 'test'] };
    expect(gate({ evidence })).toBeNull();
    expect(evidenceCovers(evidence, HEAD, wanted)).toBe(true);
  });

  it('каждый отказ называет одну причину и одну команду', () => {
    const run = 'Запустите: kaiten verify PRJ-1';
    expect(gate({})).toBe(`проверки проекта по задаче не запускались. ${run}`);
    expect(gate({ evidence: { commit: OTHER, passed: true, names: wanted } })).toBe(
      `проверки проекта шли на коммите bbbbbbbbbb, а сейчас в ветке aaaaaaaaaa: коммит после прогона его обесценивает. ${run}`,
    );
    expect(gate({ evidence: { commit: HEAD, passed: false, names: wanted } })).toBe(`проверки проекта на коммите aaaaaaaaaa не прошли. Исправьте, закоммитьте и запустите: kaiten verify PRJ-1`);
    expect(gate({ evidence: { commit: HEAD, passed: true, names: ['typecheck'] } })).toBe(`с прошлого прогона у проекта появились проверки (test). ${run}`);
  });

  it('незакоммиченное — отказ даже при успешном прогоне на этом коммите', () => {
    expect(gate({ dirty: true, evidence: { commit: HEAD, passed: true, names: wanted } })).toContain('незакоммиченные изменения');
    expect(evidenceCovers({ commit: OTHER, passed: true, names: wanted }, HEAD, wanted)).toBe(false);
    expect(evidenceCovers(undefined, HEAD, wanted)).toBe(false);
  });

  it('гейты — для задач с кодом', () => {
    expect((['story', 'tech', 'bug', 'spike', 'epic'] as const).map(gatesApply)).toEqual([true, true, true, false, false]);
  });

  it('запись в журнал — только имена, исход и время', () => {
    expect(verifyEntry(passed, HEAD)).toBe('проверки пройдены: typecheck — прошла (12 с), test — прошла (3 мин 05 с); коммит aaaaaaaaaa');
    expect(verifyEntry(failed, HEAD)).toBe('проверки не пройдены: typecheck — прошла (0,4 с), lint — не прошла (3 с), test — не запускалась; коммит aaaaaaaaaa');
    expect(verifyEntry([{ name: 'e2e', outcome: 'failed', ms: 300_000, timedOutMin: 5 }], HEAD)).toContain('e2e — не прошла: дольше 5 мин');
    expect(formatDuration(59_600)).toBe('1 мин 00 с');
  });

  it('хвост вывода: последние строки в пределе, без цвета терминала', () => {
    const output = `${Array.from({ length: 100 }, (_, i) => `строка ${i + 1}`).join('\r\n')}\n\u001b[31mFAIL\u001b[0m  src/a.test.ts\n\n`;
    const tail = outputTail(output, 3);
    expect(tail).toBe('строка 99\nстрока 100\nFAIL  src/a.test.ts');
    expect(outputTail('x'.repeat(50) + '\n' + 'y'.repeat(50), 40, 60)).toBe('y'.repeat(50));
    expect(outputTail('')).toBe('');
  });
});

describe('операция verify', () => {
  it('свидетельство — в шапку задачи, итог — в журнал; текст задачи и его хеш не меняются', () => {
    const texts = new Map([[PATH, file()]]);
    const before = tasksOf(texts)[0];
    apply(texts, { kind: 'verify', id: ID, commit: HEAD, results: passed });
    const fm = fmOf(texts.get(PATH));
    expect(fm.checks).toEqual({ commit: HEAD, passed: true, names: ['typecheck', 'test'] });
    expect(fm.updated).toBe('2026-11-01');
    expect(contentHash(fm, tasksOf(texts)[0].body)).toBe(contentHash(before.fm, before.body));
    expect(texts.get('active/export-orders.log.md')).toBe('## [2026-11-12 10:15:00 +03:00 · alice] проверки пройдены: typecheck — прошла (12 с), test — прошла (3 мин 05 с); коммит aaaaaaaaaa\n');
  });

  it('упавшая проверка: в журнале «не прошла», свидетельство — об отказе; следующий прогон его заменяет', () => {
    const texts = new Map([[PATH, file()]]);
    apply(texts, { kind: 'verify', id: ID, commit: HEAD, results: failed });
    expect(fmOf(texts.get(PATH)).checks).toEqual({ commit: HEAD, passed: false, names: ['typecheck', 'lint', 'test'] });
    expect(texts.get('active/export-orders.log.md')).toContain('lint — не прошла');
    apply(texts, { kind: 'verify', id: ID, commit: OTHER, results: passed });
    expect(fmOf(texts.get(PATH)).checks).toEqual({ commit: OTHER, passed: true, names: ['typecheck', 'test'] });
  });

  it('запись о прогоне — не запись о работе', () => {
    const texts = new Map([[PATH, file()]]);
    apply(texts, { kind: 'move', id: ID, status: 'in-progress' });
    const started = new Map([[PATH, file({ status: 'ready' })]]);
    apply(started, { kind: 'move', id: ID, status: 'in-progress' });
    apply(started, { kind: 'verify', id: ID, commit: HEAD, results: passed });
    expect(hasWorkNote(started.get('active/export-orders.log.md') ?? null)).toBe(false);
    apply(started, { kind: 'log', id: ID, text: 'Сделал выгрузку, проверил тестом' });
    expect(hasWorkNote(started.get('active/export-orders.log.md') ?? null)).toBe(true);
  });

  it('свидетельство правкой текста задачи не поставить и не поменять', () => {
    const texts = new Map([[PATH, file()]]);
    const task = tasksOf(texts)[0];
    const forged = file({ checks: { commit: HEAD, passed: true, names: ['typecheck', 'test'] } });
    const result = applyOp({ kind: 'edit', id: ID, text: forged, baseHash: contentHash(task.fm, task.body) }, texts as TaskTexts, CTX);
    expect('error' in result && result.error).toContain('эти поля правятся не в тексте задачи: checks');
  });

  it('без проверок и без коммита прогон не записывается', () => {
    const texts = new Map([[PATH, file()]]) as TaskTexts;
    expect(applyOp({ kind: 'verify', id: ID, commit: HEAD, results: [] }, texts, CTX)).toEqual({ error: 'прогон без проверок' });
    expect(applyOp({ kind: 'verify', id: ID, commit: 'abc', results: passed }, texts, CTX)).toEqual({ error: 'прогон без коммита' });
  });
});

describe('«Как проверить»', () => {
  const body = '## Зачем\n\nНужно.\n\n## Что сделать\n\nСделать.\n\n## Критерии готовности\n\n- [ ] Работает\n\n## Шаги\n\n- [ ] Раз\n';

  it('без настройки проекта раздел не требуется — как раньше', () => {
    expect(newBodyProblems('story', body)).toEqual([]);
    expect(newBodyProblems('story', body, {})).toEqual([]);
    expect(newBodyTemplate('story')).not.toContain('Как проверить');
  });

  it('с настройкой story без раздела или с пустым разделом отклоняется; tech и bug — нет', () => {
    expect(newBodyProblems('story', body, { testPlan: true }).join()).toContain('нет раздела «Как проверить»');
    expect(newBodyProblems('story', body, { testPlan: true }).join()).toContain('--no-test-plan');
    const empty = body.replace('## Шаги', '## Как проверить\n\n## Шаги');
    expect(newBodyProblems('story', empty, { testPlan: true }).join()).toContain('раздел «Как проверить» не заполнен');
    const filled = body.replace('## Шаги', '## Как проверить\n\nИнтеграционный тест выгрузки; открыть отчёт и сверить сумму.\n\n## Шаги');
    expect(newBodyProblems('story', filled, { testPlan: true })).toEqual([]);
    expect(newBodyProblems('tech', body, { testPlan: true })).toEqual([]);
    expect(newBodyProblems('bug', '## Что происходит\n\nA\n\n## Как воспроизвести\n\n1. B\n\n## Как должно быть\n\nC\n\n## Критерии\n\n- [ ] D\n', { testPlan: true })).toEqual([]);
  });

  it('в шаблоне раздел стоит перед «Шаги», заготовка — про интеграционные тесты и чёрный ящик', () => {
    const template = withTestPlanTemplate('story', newBodyTemplate('story'));
    expect(template.indexOf('## Критерии готовности')).toBeLessThan(template.indexOf('## Как проверить'));
    expect(template.indexOf('## Как проверить')).toBeLessThan(template.indexOf('## Шаги'));
    expect(template).toContain('<какие интеграционные тесты добавить или изменить и как проверить результат как чёрный ящик, не читая код>');
    // Заготовку нужно заменить: шаблон как есть не проходит.
    expect(newBodyProblems('story', template, { testPlan: true }).join()).toContain('раздел «Как проверить» не заполнен');
    expect(withTestPlanTemplate('tech', newBodyTemplate('tech'))).toBe(newBodyTemplate('tech'));
  });

  it('--no-test-plan: причина ложится в раздел перед «Шаги», и задача проходит', () => {
    const waived = withTestPlanWaiver('story', body, 'только текст на экране');
    expect(waived).toContain('## Как проверить\n\nПроверять нечего: только текст на экране\n\n## Шаги');
    expect(newBodyProblems('story', waived, { testPlan: true })).toEqual([]);
    // Раздел уже есть — причина под его заголовком; «Шагов» нет — раздел в конце.
    expect(withTestPlanWaiver('story', '## Зачем\n\nA\n\n## Как проверить\n\n## Шаги\n', 'нечего')).toContain('## Как проверить\n\nПроверять нечего: нечего\n\n## Шаги');
    expect(withTestPlanWaiver('story', '## Зачем\n\nA\n', 'нечего')).toBe('## Зачем\n\nA\n\n## Как проверить\n\nПроверять нечего: нечего\n');
  });
});

describe('домен в задаче', () => {
  const domains = { core: 'человек читает изменения целиком', generic: 'пролистать после гейтов' };

  it('хеш содержимого задачи без домена — прежний: карточки не перерисовываются', () => {
    const task = tasksOf(new Map([[PATH, file({ epic: '500', related: ['other-task'] })]]))[0];
    // Как считался хеш до поля `domain`: поля файла в порядке таблицы и тело.
    const fields = (['title', 'summary', 'repo', 'epic', 'related'] as const).map((name) => [name, task.fm[name] ?? null]);
    const old = `sha256:${createHash('sha256').update(JSON.stringify({ fields, body: task.body.replace(/\s+$/, '') })).digest('hex')}`;
    expect(contentHash(task.fm, task.body)).toBe(old);
    const withDomain = tasksOf(new Map([[PATH, file({ domain: 'core' })]]))[0];
    expect(contentHash(withDomain.fm, withDomain.body)).not.toBe(contentHash({ ...withDomain.fm, domain: undefined }, withDomain.body));
  });

  it('домен — поле текста задачи: правкой меняется', () => {
    const texts = new Map([[PATH, file()]]);
    const task = tasksOf(texts)[0];
    apply(texts, { kind: 'edit', id: ID, text: file({ domain: 'core' }), baseHash: contentHash(task.fm, task.body) });
    expect(fmOf(texts.get(PATH)).domain).toBe('core');
  });

  it('show и list: домен виден только в проекте с доменами', () => {
    const task = tasksOf(new Map([[PATH, file({ domain: 'core' })]]))[0];
    const plain = tasksOf(new Map([[PATH, file()]]))[0];
    expect(formatShow([task], task, [], null, domains)).toContain('Домен: core — человек читает изменения целиком');
    expect(formatShow([plain], plain, [], null, domains)).toContain('Домен: не указан');
    expect(formatTaskLines([task], [task], false, domains)[0]).toContain('· домен core');
    expect(domainLine(tasksOf(new Map([[PATH, file({ domain: 'billing' })]]))[0], domains)).toBe('Домен: billing (в проекте такого больше нет)');
    // Проект без доменов: ни строки, ни хвоста — даже если поле в задаче осталось.
    expect(formatShow([task], task, [], null)).not.toContain('Домен');
    expect(formatTaskLines([task], [task], false)[0]).not.toContain('домен');
    expect(formatShow([plain], plain, [])).not.toContain('Домен');
    expect('domain' in taskJson([plain], plain)).toBe(false);
    expect(taskJson([task], task).domain).toBe('core');
  });

  it('поле «Домен» карточки — только у проекта, где оно заведено', () => {
    const task = tasksOf(new Map([[PATH, file({ domain: 'core' })]]))[0];
    const plain = tasksOf(new Map([[PATH, file()]]))[0];
    const mapping = { boardId: 1, columns: {}, domainProperty: { id: 9, values: { core: 91, generic: 92 } } };
    expect(fileProperties(task, mapping)).toEqual({ id_9: [91] });
    // У задачи без домена поле не трогаем: его могли поставить в Kaiten руками.
    expect(fileProperties(plain, mapping)).toEqual({});
    expect(fileProperties(task, { boardId: 1, columns: {} })).toEqual({});
    // Домена нет среди вариантов поля — карточку не трогаем.
    expect(fileProperties(tasksOf(new Map([[PATH, file({ domain: 'billing' })]]))[0], mapping)).toEqual({});
  });
});
