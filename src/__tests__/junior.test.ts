/**
 * Признак «Можно младшему»: что засчитывается за явное «Нет», за полный
 * раздел и что попадает в причины — то, по чему команда решает, давать ли
 * задачу младшему.
 */
import { describe, expect, it } from 'vitest';

import {
  assessedBy,
  freshSince,
  incompleteSections,
  juniorMissingText,
  juniorReadiness,
  juniorTemplate,
  proposedSectionProblems,
  saysNo,
  withJuniorSections,
  withJuniorTemplate,
} from '../core/junior.js';
import type { Frontmatter, TaskStatus, TaskType } from '../core/schema.js';
import { newBodyProblems, newBodyTemplate } from '../core/skeleton.js';

const OPTS = { today: '2026-10-19', maxAgeDays: 90 };
const JUNIOR_HEADINGS = ['Продуктовые решения', 'Изменения в БД', 'Сценарии n8n'];

const PRODUCT_NO = '## Продуктовые решения\n\nНет.\n';
const DB_NO = '## Изменения в БД\n\nнет — только чтение из таблицы users\n';
const N8N_NO = '## Сценарии n8n\n\n**Нет**\n';

const DB_FULL = `## Изменения в БД

**Что меняется:** таблица orders — новое поле paid_at.
**Миграция:** существующим строкам — NULL.
**Откат:** удалить поле,
код читает его как необязательное.
- **Как проверить**: после оплаты в orders.paid_at — время оплаты.
`;

function body(...sections: string[]): string {
  return ['## Зачем\n\nЧтобы оплата подтверждалась.', '## Что сделать\n\nПовторять доставку.', ...sections, '## Критерии готовности\n\n- [ ] ретраи'].join('\n\n');
}

function check(text: string, fm: { type?: TaskType; status?: TaskStatus; created?: string; revised?: string } = {}) {
  return juniorReadiness({ type: fm.type ?? 'story', status: fm.status ?? 'backlog', created: fm.created ?? '2026-01-01', revised: fm.revised ?? '2026-10-01' }, text, OPTS);
}

describe('juniorReadiness', () => {
  it('все три раздела «Нет» — можно младшему', () => {
    expect(check(body(PRODUCT_NO, DB_NO, N8N_NO))).toEqual({ ok: true, missing: [] });
  });

  it('раздел, описанный всеми пунктами, засчитан: метка с двоеточием внутри и снаружи, текст на нескольких строках', () => {
    expect(check(body(PRODUCT_NO, DB_FULL, N8N_NO))).toEqual({ ok: true, missing: [] });
  });

  it('без разделов — «Нет» с причиной по каждому, а не отказ', () => {
    expect(check(body())).toEqual({ ok: false, missing: ['продукт: нет раздела', 'БД: нет раздела', 'n8n: нет раздела'] });
  });

  it('незаполненный каркас — раздел не заполнен', () => {
    const r = check(body(PRODUCT_NO, '## Изменения в БД\n\n<нет или пункты>\n', N8N_NO));
    expect(r?.missing).toEqual(['БД: раздел не заполнен']);
  });

  it('пункт пропущен, пустой или заготовка — его нет', () => {
    const db = '## Изменения в БД\n\n**Что меняется:** поле paid_at\n**Миграция:**\n**Откат:** <как вернуть назад>\n';
    expect(check(body(PRODUCT_NO, db, N8N_NO))?.missing).toEqual(['БД: нет пунктов «Миграция», «Откат», «Как проверить»']);
    const one = DB_FULL.replace(/- \*\*Как проверить.*\n/, '');
    expect(check(body(PRODUCT_NO, one, N8N_NO))?.missing).toEqual(['БД: нет пункта «Как проверить»']);
  });

  it('«Открытые вопросы» засчитываются только как «нет»', () => {
    const product = (answer: string) =>
      `## Продуктовые решения\n\n**Что решено:** кнопка «Оплатить» вместо «Купить».\n**Где зафиксировано:** обсуждение в чате продукта.\n**Открытые вопросы:** ${answer}\n`;
    expect(check(body(product('нет'), DB_NO, N8N_NO))?.ok).toBe(true);
    expect(check(body(product('какой текст у ошибки'), DB_NO, N8N_NO))?.missing).toEqual(['продукт: есть открытые вопросы']);
  });

  it('слово на «нет» — не «Нет»', () => {
    const r = check(body(PRODUCT_NO, '## Изменения в БД\n\nНетривиальная миграция таблицы orders.\n', N8N_NO));
    expect(r?.missing).toEqual(['БД: нет пунктов «Что меняется», «Миграция», «Откат», «Как проверить»']);
  });

  it('заголовок внутри блока кода не обрывает раздел', () => {
    const db = '## Изменения в БД\n\nНет.\n\n```\n## Сценарии n8n\n```\n';
    expect(check(body(PRODUCT_NO, db, N8N_NO))?.ok).toBe(true);
  });

  it('старше порога — устарела; ровно порог — ещё нет', () => {
    const full = body(PRODUCT_NO, DB_NO, N8N_NO);
    expect(check(full, { revised: '2026-07-21' })?.ok).toBe(true);
    expect(check(full, { revised: '2026-07-20' })).toEqual({ ok: false, missing: ['постановку не правили больше 90 дней'] });
    // Задача до поля revised — от даты создания.
    const legacy = juniorReadiness({ type: 'story', status: 'backlog', created: '2026-07-20' }, full, OPTS);
    expect(legacy?.missing).toEqual(['постановку не правили больше 90 дней']);
  });

  it('epic, spike и взятые, заблокированные, закрытые задачи — признак не применим', () => {
    const full = body(PRODUCT_NO, DB_NO, N8N_NO);
    for (const type of ['epic', 'spike'] as const) expect(check(full, { type })).toBeNull();
    for (const status of ['in-progress', 'review', 'blocked', 'done', 'cancelled'] as const) expect(check(full, { status })).toBeNull();
    for (const status of ['inbox', 'backlog', 'ready'] as const) expect(check(full, { status, type: 'bug' })?.ok).toBe(true);
  });

  it('незаполненный каркас разделов — не заполнен, а не «полный»', () => {
    expect(check(withJuniorTemplate('story', body()))?.missing).toEqual(['продукт: раздел не заполнен', 'БД: раздел не заполнен', 'n8n: раздел не заполнен']);
  });

  it('причины одной строкой — для поля карточки', () => {
    const r = check(body(DB_NO), { revised: '2026-01-01' });
    expect(juniorMissingText(r?.missing ?? [])).toBe('постановку не правили больше 90 дней; продукт: нет раздела; n8n: нет раздела');
  });
});

describe('оценка и признак', () => {
  const full = body(PRODUCT_NO, DB_NO, N8N_NO);
  const fm = (over: Partial<Frontmatter>) => ({ type: 'story' as const, status: 'backlog' as const, created: '2026-01-01', revised: '2026-01-01', ...over });

  it('«Похоже, сделана» и «Похоже, устарела» — «Нет» с причиной, кто бы ни поставил', () => {
    expect(juniorReadiness(fm({ revised: '2026-10-01', assessment: 'done' }), full, OPTS)?.missing).toEqual(['оценка: похоже, сделана']);
    expect(juniorReadiness(fm({ revised: '2026-10-01', assessment: 'obsolete', assessed: { verdict: 'obsolete', date: '2026-10-01' } }), full, OPTS)?.missing).toEqual(['оценка: похоже, устарела']);
  });

  it('«Актуальна» от скрипта освежает старую задачу; поправленная человеком — нет', () => {
    const script = fm({ assessment: 'actual', assessed: { verdict: 'actual', date: '2026-10-01' } });
    expect(juniorReadiness(script, full, OPTS)).toEqual({ ok: true, missing: [] });
    expect(freshSince(script)).toBe('2026-10-01');
    // Человек сначала поставил «Похоже, сделана», потом вернул «Актуальна» — это его оценка, а не скрипта.
    const human = fm({ assessment: 'actual', assessed: { verdict: 'done', date: '2026-10-01' } });
    expect(assessedBy(human)).toBe('human');
    expect(juniorReadiness(human, full, OPTS)?.missing).toEqual(['постановку не правили больше 90 дней']);
    expect(assessedBy(fm({}))).toBeNull();
  });
});

describe('разделы от скрипта оценки', () => {
  it('недостающие и неполные разделы — к дописыванию; полные и «Нет» — нет', () => {
    expect(incompleteSections(body(PRODUCT_NO, '## Изменения в БД\n\n**Что меняется:** поле\n'))).toEqual(['Изменения в БД', 'Сценарии n8n']);
    expect(incompleteSections(body(PRODUCT_NO, DB_FULL, N8N_NO))).toEqual([]);
  });

  it('открытые вопросы в предложенном разделе — честный ответ, а не ошибка; нехватка пунктов — ошибка', () => {
    const product = '**Что решено:** кнопка.\n**Где зафиксировано:** чат продукта.\n**Открытые вопросы:** какой текст у ошибки';
    expect(proposedSectionProblems('Продуктовые решения', product)).toEqual([]);
    expect(proposedSectionProblems('Изменения в БД', '**Что меняется:** поле')).toEqual(['БД: нет пунктов «Миграция», «Откат», «Как проверить»']);
    expect(proposedSectionProblems('Изменения в БД', '')).toEqual(['БД: раздел не заполнен']);
  });

  it('«Нет» — по первой строке раздела', () => {
    expect(saysNo('Нет — только чтение.')).toBe(true);
    expect(saysNo('Нетривиально')).toBe(false);
    expect(saysNo('**Что меняется:** поле')).toBe(false);
  });

  it('есть раздел — заменяется на месте; нет — встаёт перед критериями в порядке каркаса', () => {
    const before = body('## Изменения в БД\n\n**Что меняется:** поле\n\n### Подробности\n\nтекст');
    const out = withJuniorSections('story', before, { 'Сценарии n8n': 'Нет.', 'Изменения в БД': 'Нет — только чтение.', 'Продуктовые решения': 'Нет.' });
    const headings = out.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toEqual(['## Зачем', '## Что сделать', '## Изменения в БД', '## Продуктовые решения', '## Сценарии n8n', '## Критерии готовности']);
    expect(out).not.toContain('Подробности');
    expect(check(out)).toEqual({ ok: true, missing: [] });
    expect(out.endsWith('- [ ] ретраи\n')).toBe(true);
  });

  it('без критериев — в конец', () => {
    const out = withJuniorSections('story', '## Зачем\n\nТекст.\n', { 'Сценарии n8n': 'Нет.' });
    expect(out).toBe('## Зачем\n\nТекст.\n\n## Сценарии n8n\n\nНет.\n');
  });
});

describe('каркас разделов для kaiten new', () => {
  const headings = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));

  it('разделы — перед критериями: у story после «Что сделать», у bug после «Как должно быть»', () => {
    expect(headings(withJuniorTemplate('story', newBodyTemplate('story')))).toEqual([
      'Зачем', 'Что сделать', 'Продуктовые решения', 'Изменения в БД', 'Сценарии n8n', 'Критерии готовности', 'Шаги',
    ]);
    expect(headings(withJuniorTemplate('bug', newBodyTemplate('bug')))).toEqual([
      'Что происходит', 'Как воспроизвести', 'Как должно быть', 'Продуктовые решения', 'Изменения в БД', 'Сценарии n8n', 'Критерии',
    ]);
  });

  it('у epic и spike разделов нет', () => {
    for (const type of ['epic', 'spike'] as const) expect(withJuniorTemplate(type, newBodyTemplate(type))).toBe(newBodyTemplate(type));
  });

  it('заготовки, которые не заменили, kaiten new не пропустит — ни строку «Нет…», ни пункт с меткой', () => {
    const filled = ['## Зачем', 'Чтобы оплата подтверждалась.', '## Что сделать', 'Повторять доставку.', '## Критерии готовности', '- [ ] ретраи'].join('\n\n');
    expect(newBodyProblems('story', filled)).toEqual([]);
    expect(newBodyProblems('story', withJuniorTemplate('story', filled))).toEqual(['остались заготовки шаблона <…> — замените их текстом или удалите']);
    const onlyLabel = filled.replace('## Критерии', '## Изменения в БД\n\n- **Откат:** <как вернуть назад>\n\n## Критерии');
    expect(newBodyProblems('story', onlyLabel)).toEqual(['остались заготовки шаблона <…> — замените их текстом или удалите']);
  });

  it('заполненный каркас засчитан; пустые разделы — можно завести, признак «Нет»', () => {
    const tpl = juniorTemplate();
    const answered = tpl
      .replace(/<«Нет», если задача не требует[^>]*>\n(- .*\n?)+/, 'Нет.\n')
      .replace(/<«Нет», если проверили по коду[^>]*>\n(- .*\n?)+/, 'Нет — только чтение.\n')
      .replace(/<«Нет», если проверили, что сценарии[^>]*>\n(- .*\n?)+/, 'Нет\n');
    expect(check(body(answered))).toEqual({ ok: true, missing: [] });
    const blank = JUNIOR_HEADINGS.map((h) => `## ${h}`).join('\n\n');
    expect(newBodyProblems('story', body(blank))).toEqual([]);
    expect(check(body(blank))?.missing).toEqual(['продукт: раздел не заполнен', 'БД: раздел не заполнен', 'n8n: раздел не заполнен']);
  });
});
