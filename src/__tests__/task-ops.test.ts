/**
 * Операции записи: что агент может поменять в задаче и что CLI не пропустит.
 */
import { describe, expect, it } from 'vitest';

import { contentHash, parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { appendLog, applyOp, attachmentNameProblem, hasWorkNote, matchItem, newTaskText, slugify, uniqueSlug, type FileChange, type Op, type TaskTexts } from '../core/task-ops.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const CTX = { date: '2026-09-28' };

function task(overrides: Partial<Frontmatter> = {}, body = '## Критерии\n\n- [ ] Тест на таймаут\n- [ ] Ретраи с паузой\n  и джиттером\n- [x] Воспроизвести\n'): string {
  const fm = FrontmatterSchema.parse({
    id: ID,
    tracker: '10000002',
    title: 'Починить таймаут вебхука',
    summary: 'Оплата иногда зависает.',
    type: 'bug',
    status: 'ready',
    repo: 'acme-app',
    priority: 'p1',
    created: '2026-09-16',
    created_by: 'alice',
    updated: '2026-09-16',
    ...overrides,
  });
  return serializeTaskDocument(fm, body);
}

const texts = (extra: Record<string, string> = {}): TaskTexts => new Map(Object.entries({ 'active/webhook-timeout.md': task(), ...extra }));

function ok(result: ReturnType<typeof applyOp>): FileChange[] {
  if ('error' in result) throw new Error(result.error);
  return result.changes;
}

function fmOf(text: string | null): Frontmatter {
  return FrontmatterSchema.parse(parseTaskDocument(text ?? '').data);
}

describe('slug', () => {
  it('латиница из русского заголовка, до ~50 знаков по слову, без повторов', () => {
    expect(slugify('Починить таймаут вебхука оплаты!')).toBe('pochinit-taymaut-vebkhuka-oplaty');
    expect(slugify('Очень длинный заголовок задачи, который никак не помещается в пятьдесят знаков').length).toBeLessThanOrEqual(50);
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3');
  });
});

describe('пункты', () => {
  const body = parseTaskDocument(task()).body;

  it('по точному тексту или по единственному совпадению слов', () => {
    expect(matchItem(body, 'тест на таймаут')).toEqual({ item: 'Тест на таймаут' });
    expect(matchItem(body, 'джиттером')).toEqual({ item: 'Ретраи с паузой и джиттером' });
  });

  it('промах — список неотмеченных; двусмысленность — варианты', () => {
    const miss = matchItem(body, 'деплой');
    expect('error' in miss && miss.error).toContain('- Тест на таймаут');
    expect('error' in miss && miss.error).not.toContain('Воспроизвести');
    const both = matchItem(body, 'т');
    expect('error' in both && both.error).toContain('нескольким');
  });

  it('check отмечает пункт, в т. ч. многострочный; повтор — без изменений', () => {
    const [change] = ok(applyOp({ kind: 'check', id: ID, items: ['Ретраи с паузой и джиттером'], checked: true }, texts(), CTX));
    expect(change.text).toContain('- [x] Ретраи с паузой\n  и джиттером');
    expect(fmOf(change.text).updated).toBe('2026-09-28');
    // «Доставлено в Kaiten» ставит только синхронизация — правка его не трогает.
    expect(fmOf(change.text).content_hash).toBeUndefined();
    expect(ok(applyOp({ kind: 'check', id: ID, items: ['Воспроизвести'], checked: true }, texts(), CTX))).toEqual([]);
    const off = ok(applyOp({ kind: 'check', id: ID, items: ['Воспроизвести'], checked: false }, texts(), CTX));
    expect(off[0].text).toContain('- [ ] Воспроизвести');
  });
});

describe('журнал', () => {
  it('запись с датой, первая строка — заголовок', () => {
    expect(appendLog(null, CTX.date, 'Воспроизвёл на staging\nпричина в ретраях')).toBe('## [2026-09-28] Воспроизвёл на staging\nпричина в ретраях\n');
    expect(appendLog('## [2026-09-01] создана\n', CTX.date, 'ещё')).toBe('## [2026-09-01] создана\n\n## [2026-09-28] ещё\n');
    const [change] = ok(applyOp({ kind: 'log', id: ID, text: 'заметка' }, texts(), CTX));
    expect(change.path).toBe('active/webhook-timeout.log.md');
  });
});

describe('отмена и блокировка', () => {
  it('отмена переносит задачу и журнал в архив месяца', () => {
    const changes = ok(applyOp({ kind: 'cancel', id: ID, reason: 'дубль PRJ-1' }, texts({ 'active/webhook-timeout.log.md': '## [2026-09-16] создана\n' }), CTX));
    expect(changes.map((c) => [c.path, c.text === null])).toEqual([
      ['active/webhook-timeout.md', true],
      ['active/webhook-timeout.log.md', true],
      ['archive/2026-09/webhook-timeout.md', false],
      ['archive/2026-09/webhook-timeout.log.md', false],
    ]);
    expect(fmOf(changes[2].text).status).toBe('cancelled');
    expect(changes[3].text).toContain('## [2026-09-28] отменена: дубль PRJ-1');
  });

  it('отменить задачу в работе нельзя — как на доске', () => {
    const r = applyOp({ kind: 'cancel', id: ID, reason: 'x' }, new Map([['active/webhook-timeout.md', task({ status: 'in-progress' })]]), CTX);
    expect('error' in r && r.error).toContain('только из inbox, backlog, ready');
  });

  it('блокировка — статус и причина в журнале; без причины нельзя', () => {
    const changes = ok(applyOp({ kind: 'block', id: ID, reason: 'ждём доступ к платёжному кабинету' }, texts(), CTX));
    expect(fmOf(changes[0].text).status).toBe('blocked');
    expect(changes[1].text).toContain('заблокирована: ждём доступ');
    expect('error' in applyOp({ kind: 'block', id: ID, reason: ' ' }, texts(), CTX)).toBe(true);
  });
});

describe('запись о работе в журнале (для review)', () => {
  const log = (...heads: string[]): string => heads.map((h) => '## [2026-09-28] ' + h).join('\n\n') + '\n';

  it('записи смены статуса не в счёт, запись о работе после взятия в работу — в счёт', () => {
    expect(hasWorkNote(null)).toBe(false);
    expect(hasWorkNote(log('в работе'))).toBe(false);
    expect(hasWorkNote(log('в работе (из «Бэклога», по прямому поручению)', 'заблокирована: ждём ключ'))).toBe(false);
    expect(hasWorkNote(log('в работе', 'Причина — ретраи без паузы\nТест на таймаут добавлен.'))).toBe(true);
    // «в работе над X» — запись человека, не смена статуса.
    expect(hasWorkNote(log('в работе', 'в работе над экспортом: нашёл причину'))).toBe(true);
  });

  it('запись до повторного взятия в работу — про прошлый заход; у перенесённой задачи — любая', () => {
    expect(hasWorkNote(log('в работе', 'Разобрал причину', 'на ревью: PR #1', 'в работе'))).toBe(false);
    expect(hasWorkNote(log('Сделали прототип'))).toBe(true);
  });
});

describe('статусы работы', () => {
  it('в работу → на ревью → сделана: журнал, сделанная — в архив месяца операции', () => {
    const state = new Map(texts());
    const step = (op: Op): FileChange[] => {
      const changes = ok(applyOp(op, state, CTX));
      for (const c of changes) if (c.text === null) state.delete(c.path);
      else state.set(c.path, c.text);
      return changes;
    };
    step({ kind: 'move', id: ID, status: 'in-progress', branch: 'feature/webhook-timeout' });
    expect(fmOf(state.get('active/webhook-timeout.md') ?? null)).toMatchObject({ status: 'in-progress', branch: 'feature/webhook-timeout' });
    step({ kind: 'move', id: ID, status: 'review', note: 'PR #45' });
    const done = step({ kind: 'move', id: ID, status: 'done', note: 'влито в main' });
    expect(done.map((c) => [c.path, c.text === null])).toEqual([
      ['active/webhook-timeout.md', true],
      ['active/webhook-timeout.log.md', true],
      ['archive/2026-09/webhook-timeout.md', false],
      ['archive/2026-09/webhook-timeout.log.md', false],
    ]);
    expect(fmOf(state.get('archive/2026-09/webhook-timeout.md') ?? null).status).toBe('done');
    expect(state.get('archive/2026-09/webhook-timeout.log.md')).toBe(
      '## [2026-09-28] в работе\n\n## [2026-09-28] на ревью: PR #45\n\n## [2026-09-28] сделана: влито в main\n',
    );
  });

  it('переходы — как ограничения доски; повтор — без изменений; эпик — не так', () => {
    const r = applyOp({ kind: 'move', id: ID, status: 'done' }, texts(), CTX);
    expect('error' in r && r.error).toBe('задача в статусе ready: сделана — только из review');
    expect(applyOp({ kind: 'move', id: ID, status: 'review' }, texts(), CTX)).toMatchObject({ error: 'задача в статусе ready: на ревью — только из in-progress' });
    expect(ok(applyOp({ kind: 'move', id: ID, status: 'in-progress' }, new Map([['active/webhook-timeout.md', task({ status: 'in-progress' })]]), CTX))).toEqual([]);
    // С ревью вернули на доработку.
    expect(ok(applyOp({ kind: 'move', id: ID, status: 'in-progress' }, new Map([['active/webhook-timeout.md', task({ status: 'review' })]]), CTX))).toHaveLength(2);
    const epic = new Map([['active/webhook-timeout.md', task({ type: 'epic', status: 'review', repo: undefined })]]);
    expect(applyOp({ kind: 'move', id: ID, status: 'done' }, epic, CTX)).toMatchObject({ error: 'это эпик: его закрывают в Kaiten, когда закрыты его задачи' });
  });
});

describe('правка текста', () => {
  const current = texts().get('active/webhook-timeout.md') ?? '';
  const { data, body } = parseTaskDocument(current);
  const fm = FrontmatterSchema.parse(data);
  const base = contentHash(fm, body);

  it('меняет тело и поля файла', () => {
    const edited = current.replace('- [ ] Тест на таймаут', '- [ ] Тест на таймаут и на 503').replace('Оплата иногда зависает.', 'Оплата зависает на два часа.');
    const [change] = ok(applyOp({ kind: 'edit', id: ID, text: edited, baseHash: base }, texts(), CTX));
    expect(change.text).toContain('Тест на таймаут и на 503');
    expect(fmOf(change.text).summary).toBe('Оплата зависает на два часа.');
  });

  it('поля Kaiten и CLI руками не меняются', () => {
    const r = applyOp({ kind: 'edit', id: ID, text: current.replace('status: ready', 'status: done').replace('priority: p1', 'priority: p0'), baseHash: base }, texts(), CTX);
    expect('error' in r && r.error).toContain('status, priority');
  });

  it('одновременная правка другим — отказ, без изменений — пусто', () => {
    const r = applyOp({ kind: 'edit', id: ID, text: current, baseHash: 'sha256:other' }, texts(), CTX);
    expect('error' in r && r.error).toContain('одновременно');
    expect(ok(applyOp({ kind: 'edit', id: ID, text: current, baseHash: base }, texts(), CTX))).toEqual([]);
  });

  it('отметку «доставлено в Kaiten» правкой не подделать', () => {
    const forged = current.replace(/^updated: .*$/m, (line) => `${line}\ncontent_hash: sha256:${'b'.repeat(64)}`).replace('Оплата иногда зависает.', 'Новая «Суть».');
    const [change] = ok(applyOp({ kind: 'edit', id: ID, text: forged, baseHash: base }, texts(), CTX));
    expect(fmOf(change.text).content_hash).toBeUndefined();
  });

  it('битый файл не пишется', () => {
    const r = applyOp({ kind: 'edit', id: ID, text: current.replace(/^title: .*$/m, 'title: ""'), baseHash: base }, texts(), CTX);
    expect('error' in r).toBe(true);
  });
});

describe('новая задача', () => {
  const input = {
    id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B',
    slug: 'pochinit-503',
    title: 'Починить ответ на 503',
    summary: 'Вебхук теряется, если база ответила ошибкой.',
    type: 'bug' as const,
    repo: 'acme-app',
    createdBy: 'alice',
    createdVia: 'agent' as const,
  };

  it('во «Входящих», без приоритета, со скелетом по типу', () => {
    const text = newTaskText(input, CTX.date);
    if (typeof text !== 'string') throw new Error(text.error);
    const fm = fmOf(text);
    expect([fm.status, fm.priority, fm.created_via, fm.created]).toEqual(['inbox', undefined, 'agent', '2026-09-28']);
    expect(text).toContain('## Как воспроизвести');
    const op: Op = { kind: 'new', path: 'active/pochinit-503.md', text };
    expect(ok(applyOp(op, texts(), CTX))).toEqual([{ path: 'active/pochinit-503.md', text }]);
    // Имя заняли, пока задача не отправлена, — она получает следующее, а не пропадает.
    const other = text.replace(input.id, '01K5ZQ3R8F2K9M4N7P0T5V8W3C');
    const renamed = applyOp({ kind: 'new', path: 'active/pochinit-503.md', text: other }, texts({ 'active/pochinit-503.md': text }), CTX);
    expect(ok(renamed)[0].path).toBe('active/pochinit-503-2.md');
    expect('error' in renamed || renamed.summary).toContain('было занято');
    expect(text).not.toMatch(/^- \[ \] $/m);
  });

  it('без «Сути» задачу не создать', () => {
    expect(typeof newTaskText({ ...input, summary: '' }, CTX.date)).toBe('object');
  });
});

describe('пункт с обратными кавычками', () => {
  const ITEM = '`npm run cli -- clear` убирает купленное';
  const body = '## Критерии\n\n- [ ] ' + ITEM + '\n- [ ] Тест\n';

  it('находится и без кавычек, и с ними; отмечается исходный текст', () => {
    expect(matchItem(body, 'npm run cli -- clear убирает купленное')).toEqual({ item: ITEM });
    expect(matchItem(body, '`npm run cli -- clear`')).toEqual({ item: ITEM });
    const [change] = ok(applyOp({ kind: 'check', id: ID, items: [ITEM], checked: true }, new Map([['active/webhook-timeout.md', task({}, body)]]), CTX));
    expect(change.text).toContain('- [x] ' + ITEM);
  });
});

describe('вложение', () => {
  const BLOB = 'a'.repeat(40);

  it('ложится в папку вложений задачи готовым объектом, файл задачи не трогает', () => {
    const changes = ok(applyOp({ kind: 'attach', id: ID, name: 'HANDOFF.md', blob: BLOB }, texts(), CTX));
    expect(changes).toEqual([{ path: 'attachments/webhook-timeout/HANDOFF.md', text: null, blob: BLOB }]);
    expect(ok(applyOp({ kind: 'attach', id: ID, name: 'img/схема v2.png', blob: BLOB }, texts(), CTX))[0].path).toBe('attachments/webhook-timeout/img/схема v2.png');
  });

  it('имя не выводит за папку вложений', () => {
    for (const bad of ['../x.md', '/x.md', 'a/../../x.md', 'a\\b.md', '', 'a/b/c/d.md', '.git/config', 'x;rm.md']) {
      expect(attachmentNameProblem(bad), bad).not.toBeNull();
      expect('error' in applyOp({ kind: 'attach', id: ID, name: bad, blob: BLOB }, texts(), CTX), bad).toBe(true);
    }
    for (const good of ['HANDOFF.md', 'report (2).pdf', 'data/photos.json', '_notes.md']) expect(attachmentNameProblem(good), good).toBeNull();
  });

  it('нет задачи или объекта — ошибка', () => {
    expect('error' in applyOp({ kind: 'attach', id: '01K5ZQ3R8F2K9M4N7P0T5V8W3Z', name: 'a.md', blob: BLOB }, texts(), CTX)).toBe(true);
    expect('error' in applyOp({ kind: 'attach', id: ID, name: 'a.md', blob: 'не sha' }, texts(), CTX)).toBe(true);
  });
});

describe('в работу из «Бэклога» по прямому поручению', () => {
  const backlog = (): TaskTexts => new Map([['active/webhook-timeout.md', task({ status: 'backlog' })]]);

  it('без поручения — отказ; с поручением — «в работе» и пометка в журнале', () => {
    expect('error' in applyOp({ kind: 'move', id: ID, status: 'in-progress' }, backlog(), CTX)).toBe(true);
    const changes = ok(applyOp({ kind: 'move', id: ID, status: 'in-progress', assigned: true }, backlog(), CTX));
    expect(fmOf(changes[0].text).status).toBe('in-progress');
    expect(changes[1].text).toContain('в работе (из «Бэклога», по прямому поручению)');
  });

  it('поручение не открывает остальные переходы', () => {
    const inbox: TaskTexts = new Map([['active/webhook-timeout.md', task({ status: 'inbox' })]]);
    expect('error' in applyOp({ kind: 'move', id: ID, status: 'in-progress', assigned: true }, inbox, CTX)).toBe(true);
    expect('error' in applyOp({ kind: 'move', id: ID, status: 'review', assigned: true }, backlog(), CTX)).toBe(true);
  });
});

describe('пункт и знаки препинания', () => {
  const body = '## Критерии\n\n- [ ] Команда сообщает, сколько позиций убрано\n- [ ] Для пустого списка — «Куплено: 0 из 0»\n- [ ] ' + 'list --sort показывает позиции по алфавиту\n';

  it('запятые, кавычки и тире в пункте не мешают найти его по словам', () => {
    expect(matchItem(body, 'сообщает сколько позиций')).toEqual({ item: 'Команда сообщает, сколько позиций убрано' });
    expect(matchItem(body, 'пустого списка куплено 0 из 0')).toEqual({ item: 'Для пустого списка — «Куплено: 0 из 0»' });
    // Дефис внутри слова и флаги остаются как есть.
    expect(matchItem(body, 'list --sort')).toEqual({ item: 'list --sort показывает позиции по алфавиту' });
  });
});
