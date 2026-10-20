/**
 * Оценка задач агентом: что оценивается, какой ответ агента принимается
 * (доказательства проверяются, «Нет» обосновано, разделы проходят разбор) и
 * что записывается при применении. Агент — подделка, сети нет.
 */
import { describe, expect, it } from 'vitest';

import {
  assessPrompt,
  planApply,
  runAssess,
  safeRelativePath,
  selectForAssess,
  verifyAnswer,
  type AgentAnswer,
  type CodeRepo,
  type EvidenceCheck,
} from '../core/assess.js';
import { contentHash, parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { juniorReadiness } from '../core/junior.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { applyOp, tasksOf, type TaskTexts } from '../core/task-ops.js';
import type { TaskRecord } from '../core/tasks-index.js';

const ID = '01K5ZQ3R8F2K9M4N7P0T5V8W3A';
const TODAY = '2026-10-20';
const BODY = '## Зачем\n\nЧтобы оплата подтверждалась.\n\n## Что сделать\n\nПовторять доставку вебхука.\n\n## Критерии готовности\n\n- [ ] ретраи\n';

function task(fm: Partial<Frontmatter> = {}, body = BODY): TaskRecord {
  const text = serializeTaskDocument(
    FrontmatterSchema.parse({
      id: ID,
      tracker: '600',
      title: 'Ретраи вебхука',
      summary: 'Коротко.',
      type: 'story',
      status: 'backlog',
      repo: 'acme-app',
      created: '2026-03-01',
      created_by: 'alice',
      updated: '2026-03-01',
      ...fm,
    }),
    body,
  );
  return tasksOf(new Map([['active/retry.md', text]]))[0];
}

const OPTS = { today: TODAY, maxAgeDays: 90, codeRepos: new Set(['acme-app', 'acme-n8n']) };
const REPOS: CodeRepo[] = [
  { name: 'acme-app', folder: 'C:/code/acme-app', shared: false },
  { name: 'acme-n8n', folder: 'C:/code/acme-n8n', shared: true },
];
const CHECK: EvidenceCheck = {
  repos: new Set(['acme-app', 'acme-n8n']),
  fileExists: (repo, path) => repo === 'acme-app' && ['src/webhook.ts', 'src'].includes(path),
  commitExists: (repo, sha) => repo === 'acme-app' && 'abc1234def'.startsWith(sha),
};
const DB = '- **Что меняется:** таблица webhook_attempts.\n- **Миграция:** новая таблица.\n- **Откат:** удалить таблицу.\n- **Как проверить:** строка на каждую попытку.';
const ALL = ['Продуктовые решения', 'Изменения в БД', 'Сценарии n8n'];

function answer(over: Partial<AgentAnswer> = {}): AgentAnswer {
  return {
    verdict: 'actual',
    reasoning: 'Ретраев в обработчике нет.',
    sections: [
      { name: 'Продуктовые решения', text: 'Нет.', noReason: 'поведение для пользователя не меняется' },
      { name: 'Изменения в БД', text: DB, noReason: '' },
      { name: 'Сценарии n8n', text: 'Нет — сценарии не вызывают вебхук.', noReason: 'поиск по acme-n8n: webhook не встречается' },
    ],
    evidence: [{ repo: 'acme-app', path: 'src/webhook.ts', commit: '', note: 'обработчик без повторов' }],
    ...over,
  };
}

describe('что оценивается', () => {
  const pick = (t: TaskRecord, over: Partial<typeof OPTS & { only: Set<string>; force: boolean }> = {}) => selectForAssess([t], { ...OPTS, ...over });

  it('без оценки — да; эпик, взятые и закрытые — не оцениваются и в отчёт не попадают', () => {
    expect(pick(task()).picked).toHaveLength(1);
    expect(pick(task({ type: 'epic', repo: undefined }))).toEqual({ picked: [], skipped: [] });
    expect(pick(task({ status: 'in-progress' }))).toEqual({ picked: [], skipped: [] });
  });

  it('названная явно, но не оцениваемая — в отчёте с причиной', () => {
    expect(pick(task({ status: 'review' }), { only: new Set([ID]) }).skipped[0].why).toMatch(/только открытые/);
  });

  it('без карточки и без папки кода — пропуск с причиной', () => {
    expect(pick(task({ tracker: undefined })).skipped[0].why).toMatch(/нет карточки/);
    expect(pick(task({ repo: 'acme-landing' })).skipped[0].why).toMatch(/--code acme-landing=<папка>/);
  });

  it('«Актуальна» от скрипта — заново через 90 дней; «похоже…» ждёт человека; оценку человека — только --only --force', () => {
    const script = (verdict: 'actual' | 'done', date: string) => task({ assessment: verdict, assessed: { verdict, date } });
    expect(pick(script('actual', '2026-08-01')).skipped[0].why).toBe('оценена 2026-08-01');
    expect(pick(script('actual', '2026-07-01')).picked).toHaveLength(1);
    expect(pick(script('done', '2026-01-01')).skipped[0].why).toMatch(/ждёт человека/);
    const human = task({ assessment: 'done' });
    expect(pick(human).skipped[0].why).toMatch(/поставил человек — заново только --only 600 --force/);
    expect(pick(human, { only: new Set([ID]), force: true }).picked).toHaveLength(1);
    expect(pick(human, { force: true }).picked).toHaveLength(0);
  });
});

describe('ответ агента', () => {
  it('полный ответ — запись с хешем постановки, разделами и обоснованиями «Нет»', () => {
    const t = task();
    const r = verifyAnswer(t, answer(), ALL, CHECK);
    expect('result' in r && r.result).toMatchObject({
      id: ID,
      ref: '600',
      cardId: 600,
      baseHash: contentHash(t.fm, t.body),
      verdict: 'actual',
      sections: { 'Изменения в БД': DB },
      noReasons: { 'Продуктовые решения': 'поведение для пользователя не меняется', 'Сценарии n8n': 'поиск по acme-n8n: webhook не встречается' },
      evidence: [{ repo: 'acme-app', path: 'src/webhook.ts', note: 'обработчик без повторов' }],
    });
  });

  it('выдуманные файл, коммит, чужой репозиторий и путь наружу — не принимаются', () => {
    const bad = answer({
      evidence: [
        { repo: 'acme-app', path: 'src/nope.ts', commit: '', note: 'x' },
        { repo: 'acme-app', path: '', commit: 'fff0000', note: 'x' },
        { repo: 'globex', path: 'a.ts', commit: '', note: 'x' },
        { repo: 'acme-app', path: '../secrets.txt', commit: '', note: 'x' },
        { repo: 'acme-app', path: '', commit: '', note: '' },
      ],
    });
    const r = verifyAnswer(task(), bad, ALL, CHECK);
    expect('problems' in r && r.problems).toEqual([
      'нет такого файла: acme-app: src/nope.ts',
      'нет такого коммита в истории: acme-app @ fff0000',
      'доказательство из репозитория «globex», которого агенту не давали',
      'путь вне репозитория: acme-app: ../secrets.txt',
      'доказательство без файла и коммита: acme-app',
      'не сказано, что доказывает: acme-app',
    ]);
  });

  it('«Нет» без обоснования, неполный раздел, пропущенный раздел — не принимаются', () => {
    const r = verifyAnswer(
      task(),
      answer({
        sections: [
          { name: 'Продуктовые решения', text: 'Нет.', noReason: ' ' },
          { name: 'Изменения в БД', text: '**Что меняется:** поле', noReason: '' },
        ],
      }),
      ALL,
      CHECK,
    );
    expect('problems' in r && r.problems).toEqual([
      '«Нет» в разделе «Продуктовые решения» без обоснования',
      'раздел «Изменения в БД»: БД: нет пунктов «Миграция», «Откат», «Как проверить»',
      'нет раздела «Сценарии n8n»',
    ]);
  });

  it('разделы, которых не просили, не берутся: полные разделы человека скрипт не переписывает', () => {
    const r = verifyAnswer(task(), answer(), ['Изменения в БД'], CHECK);
    expect('result' in r && Object.keys(r.result.sections)).toEqual(['Изменения в БД']);
  });

  it('«Похоже, сделана» — только с доказательствами; разделы не нужны', () => {
    expect(verifyAnswer(task(), answer({ verdict: 'done', sections: [], evidence: [] }), ALL, CHECK)).toEqual({ problems: ['«Похоже, сделана» без доказательств'] });
    const r = verifyAnswer(task(), answer({ verdict: 'done', sections: [], evidence: [{ repo: 'acme-app', path: '', commit: 'ABC1234', note: 'ретраи добавлены' }] }), ALL, CHECK);
    expect('result' in r && r.result).toMatchObject({ verdict: 'done', sections: {}, evidence: [{ commit: 'abc1234' }] });
  });

  it('путь: относительный, без «..»; обратные слэши — прямые', () => {
    expect(safeRelativePath('src\\a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('./src/')).toBe('src');
    expect(safeRelativePath('/etc/passwd')).toBeNull();
    expect(safeRelativePath('C:/x')).toBeNull();
    expect(safeRelativePath('a/../../b')).toBeNull();
  });
});

describe('задание агенту', () => {
  it('репозитории с git-командами, только недостающие разделы, файл задачи целиком', () => {
    const t = task();
    const prompt = assessPrompt(t, 'ТЕКСТ ЗАДАЧИ', REPOS, ['Изменения в БД']);
    expect(prompt).toContain('- acme-app — репозиторий задачи, текущая папка: C:/code/acme-app');
    expect(prompt).toContain('`git -C C:/code/acme-n8n log …`');
    expect(prompt).toContain('«Изменения в БД»');
    expect(prompt).not.toContain('«Сценарии n8n»:');
    expect(prompt).toContain('ТЕКСТ ЗАДАЧИ');
  });
});

describe('прогон', () => {
  it('ответы проверяются; ошибка агента и ответ не по схеме — «не справился»; порядок — как у задач', async () => {
    const tasks = [task(), task({ id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B', tracker: '601' }), task({ id: '01K5ZQ3R8F2K9M4N7P0T5V8W3C', tracker: '602' })];
    const run = await runAssess(tasks, {
      repos: REPOS,
      taskText: () => 'текст',
      check: CHECK,
      parallel: 2,
      run: async ({ task: t }) => {
        if (t.fm.tracker === '601') return { error: 'агент не ответил' };
        if (t.fm.tracker === '602') return { answer: { verdict: 'maybe' } };
        return { answer: answer(), costUsd: 0.5 };
      },
    });
    expect(run.results.map((r) => r.ref)).toEqual(['600']);
    expect(run.failed.map((f) => [f.task.fm.tracker, f.problems[0].slice(0, 17)])).toEqual([
      ['601', 'агент не ответил'],
      ['602', 'ответ не по схеме'],
    ]);
    expect(run.costUsd).toBe(0.5);
  });
});

describe('применение', () => {
  const result = (t: TaskRecord, over: Partial<AgentAnswer> = {}) => {
    const r = verifyAnswer(t, answer(over), ALL, CHECK);
    if (!('result' in r)) throw new Error(r.problems.join('; '));
    return r.result;
  };

  it('разделы дописываются перед критериями, признак после них — «Да»; комментарий — вердикт и доказательства', () => {
    const t = task();
    const step = planApply(result(t), t, TODAY);
    if ('error' in step) throw new Error(step.error);
    const body = parseTaskDocument(step.text ?? '').body;
    expect(body.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Зачем', '## Что сделать', '## Продуктовые решения', '## Изменения в БД', '## Сценарии n8n', '## Критерии готовности']);
    expect(juniorReadiness({ ...t.fm, revised: TODAY }, body, { today: TODAY, maxAgeDays: 90 })).toEqual({ ok: true, missing: [] });
    expect(step.comment).toContain('Оценка скрипта (2026-10-20): «Актуальна».');
    expect(step.comment).toContain('- acme-app: `src/webhook.ts` — обработчик без повторов');
    expect(step.comment).toContain('- «Нет» в разделе «Сценарии n8n»: поиск по acme-n8n: webhook не встречается');
  });

  it('текст через kaiten edit: поля Kaiten не тронуты, revised — дата применения', () => {
    const t = task();
    const step = planApply(result(t), t, TODAY);
    if ('error' in step || step.text === null) throw new Error('нет текста');
    const texts = new Map([[t.path, serializeTaskDocument(t.fm, t.body)]]);
    const r = applyOp({ kind: 'edit', id: ID, text: step.text, baseHash: contentHash(t.fm, t.body) }, texts as TaskTexts, { date: TODAY, stamp: '' });
    if ('error' in r) throw new Error(r.error);
    const after = FrontmatterSchema.parse(parseTaskDocument(r.changes[0].text ?? '').data);
    expect(after.revised).toBe(TODAY);
  });

  it('«Похоже, сделана» — текст не меняется, в комментарии — что решает человек', () => {
    const t = task();
    const step = planApply(result(t, { verdict: 'done', sections: [], evidence: [{ repo: 'acme-app', path: 'src', commit: 'abc1234', note: 'есть ретраи' }] }), t, TODAY);
    expect(step).toMatchObject({ text: null });
    expect('comment' in step && step.comment).toMatch(/Задачу закрывает человек/);
  });

  it('постановку изменили, задачу взяли, карточка другая, задачи нет — не применяется', () => {
    const t = task();
    const r = result(t);
    expect(planApply(r, task({}, `${BODY}\nещё строка\n`), TODAY)).toEqual({ error: 'задачу изменили после оценки — оцените заново' });
    expect(planApply(r, task({ status: 'in-progress' }), TODAY)).toEqual({ error: 'задача уже в статусе in-progress — оценка не применяется' });
    expect(planApply(r, task({ tracker: '700' }), TODAY)).toEqual({ error: 'у задачи другая карточка — оцените заново' });
    expect(planApply(r, undefined, TODAY)).toEqual({ error: 'задачи больше нет' });
  });

  it('отметка скрипта: assessment и assessed с датой операции, updated не трогается', () => {
    const t = task();
    const texts = new Map([[t.path, serializeTaskDocument(t.fm, t.body)]]);
    const r = applyOp({ kind: 'assessed', items: [{ id: ID, verdict: 'done' }] }, texts as TaskTexts, { date: TODAY, stamp: '' });
    if ('error' in r) throw new Error(r.error);
    const fm = FrontmatterSchema.parse(parseTaskDocument(r.changes[0].text ?? '').data);
    expect([fm.assessment, fm.assessed, fm.updated]).toEqual(['done', { verdict: 'done', date: TODAY }, '2026-03-01']);
  });
});
