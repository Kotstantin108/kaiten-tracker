/**
 * «Было / Стало»: какие картинки засчитываются за ответ, что команда
 * отклоняет до записи и как ответ ложится в задачу.
 */
import { describe, expect, it } from 'vitest';

import { visualFields, visualSetting } from '../config.js';
import { contentHash, parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp } from '../core/task-ops.js';
import { VISUAL_MAX_BYTES, visualAttachName, visualAttachProblem, visualDecision, visualLimitProblem, type VisualInput } from '../core/visual.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const CTX = { date: '2026-10-23', stamp: '2026-10-23 10:15:00 +03:00' };

const decide = (attachments: string[], extra: Partial<VisualInput> = {}) => visualDecision({ attachments, ref: 'PRJ-1', command: 'review', ...extra });

describe('вложение', () => {
  it('было-…/стало-… без --as — в папку было-стало/, прочее — как есть', () => {
    expect(visualAttachName('было-главная-телефон.png')).toBe('было-стало/было-главная-телефон.png');
    expect(visualAttachName('Стало-Меню.JPG')).toBe('было-стало/Стало-Меню.JPG');
    expect(visualAttachName('report.png')).toBeNull();
    expect(visualAttachName('было-x.webp')).toBeNull();
    expect(visualAttachName('shots/было-x.png')).toBeNull();
  });

  it('в папке — только картинки было-/стало- до 1 МБ', () => {
    expect(visualAttachProblem('было-стало/было-x.png', 1000)).toBeNull();
    expect(visualAttachProblem('было-стало/notes.md', 10)).toContain('только картинки');
    expect(visualAttachProblem('было-стало/было-x.png', VISUAL_MAX_BYTES + 1)).toContain('больше 1 МБ');
    expect(visualAttachProblem('report.pdf', VISUAL_MAX_BYTES * 3)).toBeNull();
  });
});

describe('ответ на review и done', () => {
  it('пары и новый экран — «Есть» с числом экранов; регистр и расширение не важны', () => {
    expect(decide(['было-стало/было-главная.png', 'было-стало/Стало-Главная.jpg', 'было-стало/стало-новый.png', 'report.md'])).toEqual({ visual: 'yes', note: '«Было / Стало»: экранов 2' });
  });

  it('ничего нет — отказ с обоими путями; ответ уже в задаче — его и оставить', () => {
    const none = decide(['report.md']);
    expect('problems' in none && none.problems[0]).toContain('kaiten attach PRJ-1 было-<экран>.png');
    expect('problems' in none && none.problems[0]).toContain('kaiten review PRJ-1 --no-visual "<почему>"');
    expect(decide([], { command: 'done', current: 'no' })).toEqual({ visual: 'no' });
    const doneAsk = decide([], { command: 'done' });
    expect('problems' in doneAsk && doneAsk.problems[0]).toContain('kaiten done PRJ-1 --no-visual');
  });

  it('--no-visual — «Нет» с причиной в журнал; пустая причина или картинки рядом — отказ', () => {
    expect(decide([], { noVisual: ' только сценарий n8n ' })).toEqual({ visual: 'no', note: 'без «Было / Стало»: только сценарий n8n' });
    expect(decide([], { noVisual: '  ' })).toEqual({ problems: ['--no-visual: напишите, почему на экране ничего не меняется'] });
    const both = decide(['было-стало/стало-x.png'], { noVisual: 'нет' });
    expect('problems' in both && both.problems[0]).toContain('уберите флаг');
  });

  it('одно «было», два файла одной стороны, картинка мимо папки, лишнее в папке — всё одним списком', () => {
    const result = decide(['было-стало/было-меню.png', 'было-стало/было-шапка.png', 'было-стало/стало-шапка.png', 'было-стало/стало-шапка.jpg', 'было-подвал.png', 'было-стало/заметки.md']);
    expect('problems' in result && result.problems).toEqual([
      'было-подвал.png лежит не в папке было-стало/ — приложите заново: kaiten attach PRJ-1 <файл> --as было-стало/было-подвал.png',
      'было-стало/заметки.md: в папке было-стало/ — только было-<экран>.png и стало-<экран>.png; уберите его: kaiten detach PRJ-1 было-стало/заметки.md',
      'было-меню без стало-меню — покажите, что стало: kaiten attach PRJ-1 стало-меню.png',
      'стало-шапка: файлов несколько (было-стало/стало-шапка.png, было-стало/стало-шапка.jpg) — оставьте один, лишние уберите: kaiten detach PRJ-1 <файл>',
    ]);
  });

  it('больше 10 экранов — отказ называет команду, которой убрать лишние, и экраны', () => {
    const many = Array.from({ length: 11 }, (_, i) => `было-стало/стало-экран${i}.png`);
    const result = decide(many);
    const problems = 'problems' in result ? result.problems : [];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('экранов «Было / Стало» 11, можно не больше 10');
    expect(problems[0]).toContain('kaiten detach PRJ-1 было-<экран>.png стало-<экран>.png');
    expect(problems[0]).toContain('Экраны: экран0, экран1');
  });
});

describe('предел экранов — до записи, в attach', () => {
  const ten = Array.from({ length: 10 }, (_, i) => [`было-стало/было-э${i}.png`, `было-стало/стало-э${i}.png`]).flat();

  it('11-й экран — отказ с командой detach; до предела — можно', () => {
    expect(visualLimitProblem('было-стало/было-новый.png', ten, 'PRJ-1')).toContain('уже 10 экранов');
    expect(visualLimitProblem('было-стало/было-новый.png', ten, 'PRJ-1')).toContain('kaiten detach PRJ-1');
    expect(visualLimitProblem('было-стало/было-новый.png', ten.slice(0, 18), 'PRJ-1')).toBeNull();
  });

  it('переснятый экран и вторая половина пары предел не трогают; прочие вложения не считаются', () => {
    expect(visualLimitProblem('было-стало/Стало-Э3.jpg', ten, 'PRJ-1')).toBeNull();
    const half = [...ten.slice(0, 18), 'было-стало/было-э9.png'];
    expect(visualLimitProblem('было-стало/стало-э9.png', half, 'PRJ-1')).toBeNull();
    expect(visualLimitProblem('report.md', ten, 'PRJ-1')).toBeNull();
    expect(visualLimitProblem('было-стало/было-новый.png', [...ten.slice(0, 18), 'report.md', 'было-стало/заметки.md'], 'PRJ-1')).toBeNull();
  });
});

describe('detach', () => {
  const fm = FrontmatterSchema.parse({ id: ID, title: 'Поменять шапку', summary: 'Шапка понятнее.', type: 'story', status: 'in-progress', repo: 'acme-app', created: '2026-10-01', created_by: 'alice', updated: '2026-10-01' });
  const texts = () => new Map([['active/header.md', serializeTaskDocument(fm, '\n## Критерии готовности\n\n- [x] Шапка\n')]]);

  it('убирает картинки из вложений задачи, задачу не трогает', () => {
    const result = applyOp({ kind: 'detach', id: ID, names: ['было-стало/было-x.png', 'было-стало/стало-x.png'] }, texts(), CTX);
    if ('error' in result) throw new Error(result.error);
    expect(result.changes).toEqual([
      { path: 'attachments/header/было-стало/было-x.png', text: null },
      { path: 'attachments/header/было-стало/стало-x.png', text: null },
    ]);
    expect(result.summary).toContain('убрано вложений: 2');
  });

  it('только папка было-стало/: прочие вложения так не убрать', () => {
    expect(applyOp({ kind: 'detach', id: ID, names: ['report.md'] }, texts(), CTX)).toMatchObject({ error: expect.stringContaining('только картинку «Было / Стало»') });
    expect(applyOp({ kind: 'detach', id: ID, names: ['было-стало/../report.md'] }, texts(), CTX)).toHaveProperty('error');
    expect(applyOp({ kind: 'detach', id: ID, names: [] }, texts(), CTX)).toHaveProperty('error');
  });
});

describe('ответ в задаче', () => {
  const fm = (over: Partial<Frontmatter> = {}): Frontmatter =>
    FrontmatterSchema.parse({ id: ID, title: 'Поменять шапку', summary: 'Шапка понятнее.', type: 'story', status: 'in-progress', repo: 'acme-app', created: '2026-10-01', created_by: 'alice', updated: '2026-10-01', ...over });
  const texts = (over: Partial<Frontmatter> = {}) => new Map([['active/header.md', serializeTaskDocument(fm(over), '\n## Критерии готовности\n\n- [x] Шапка\n')]]);

  it('review пишет visual в шапку; done его сохраняет', () => {
    const state = texts();
    const review = applyOp({ kind: 'move', id: ID, status: 'review', visual: 'yes', note: '«Было / Стало»: экранов 1' }, state, CTX);
    if ('error' in review) throw new Error(review.error);
    const text = review.changes.find((c) => c.path === 'active/header.md')?.text ?? '';
    expect(FrontmatterSchema.parse(parseTaskDocument(text).data).visual).toBe('yes');
    expect(review.changes.find((c) => c.path.endsWith('.log.md'))?.text).toContain('на ревью: «Было / Стало»: экранов 1');
    const done = applyOp({ kind: 'move', id: ID, status: 'done' }, new Map([['active/header.md', text]]), CTX);
    if ('error' in done) throw new Error(done.error);
    const archived = done.changes.find((c) => c.path === 'archive/2026-10/header.md')?.text ?? '';
    expect(FrontmatterSchema.parse(parseTaskDocument(archived).data).visual).toBe('yes');
  });

  it('незнакомое значение — не задача; правкой текста ответ не подделать', () => {
    expect(FrontmatterSchema.safeParse({ ...fm(), visual: 'maybe' }).success).toBe(false);
    const current = texts({ status: 'review', visual: 'no' });
    const text = current.get('active/header.md') ?? '';
    const { data, body } = parseTaskDocument(text);
    const base = contentHash(FrontmatterSchema.parse(data), body);
    const forged = applyOp({ kind: 'edit', id: ID, text: text.replace('visual: no', 'visual: yes'), baseHash: base }, current, CTX);
    expect(forged).toMatchObject({ error: expect.stringContaining('visual') });
  });
});

describe('настройка проекта', () => {
  const kaiten = { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий', departments: [], archiveInKaiten: false };

  it('нет блока — выключено; блок без поля — ждёт setup; с полем — включено', () => {
    expect(visualSetting({ kaiten })).toEqual({ state: 'off' });
    expect(visualSetting({ kaiten: { ...kaiten, visual: { since: '2026-10-24' } } })).toEqual({ state: 'needs-setup' });
    const mapping = { boardId: 1, columns: {}, visualProperty: { id: 9, values: { yes: 91, no: 92 } } };
    expect(visualFields({ kaiten: { ...kaiten, visual: { since: '2026-10-24' } }, mapping })).toEqual({ state: 'on', since: '2026-10-24', property: { id: 9, yes: 91, no: 92 } });
    expect(visualFields({ kaiten, mapping })).toBeUndefined();
  });
});
