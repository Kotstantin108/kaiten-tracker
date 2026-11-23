/**
 * Скрипт владельца: дозаполнить постановку открытых задач до формата `kaiten new`
 * (разделы скелета по типу, критерии или «Критериев нет: …») — руками `claude -p`.
 *
 *   pnpm run normalize --tasks <репозиторий задач> [--only <slug,…>] [--limit N]
 *     [--model sonnet] [--jobs 4] [--out <папка черновиков>] [--write]
 *
 * Без --write — сухой прогон: черновики и отчёт в --out (по умолчанию
 * tmp/normalize/<имя репозитория>), задачи не меняются. С --write — тела
 * прошедших проверку задач записываются в репозиторий задач (рабочая копия);
 * коммит и push — руками владельца после просмотра diff.
 *
 * Берутся задачи из active/, кроме «В работе» (по ним сейчас работают), у
 * которых постановка не проходит проверку `kaiten new`. Модель возвращает
 * только тело; шапку скрипт не отдаёт и не меняет (кроме `updated` и `revised`). Ответ
 * принимается, только если механически:
 *   - каждая непустая строка старого тела, кроме заголовков, есть в новом
 *     (текст переносится между разделами, но не теряется и не переписывается);
 *   - отмеченных пунктов столько же, неотмеченных — не меньше;
 *   - новая постановка проходит проверку `kaiten new` и линтер без ошибок.
 * Иначе — одна повторная попытка с перечнем нарушений, затем «человеку».
 * Добавленные строки (особенно новые критерии) — в отчёт поштучно.
 *
 * `claude -p` запускается без инструментов, без MCP и сессии, из пустой
 * папки и без переменных окружения сессии, из которой запущен скрипт.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTaskDocument, serializeTaskDocument } from './core/document.js';
import { lintTask } from './core/lint.js';
import { FrontmatterSchema, type Frontmatter, type TaskType } from './core/schema.js';
import { newBodyProblems, newBodyTemplate, NO_CRITERIA_PREFIX, SKELETONS } from './core/skeleton.js';
import { taskDate } from './core/task-ops.js';

interface Args {
  tasks: string;
  only?: string[];
  limit?: number;
  model: string;
  jobs: number;
  out: string;
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const tasks = value('--tasks');
  if (!tasks) throw new Error('Укажите --tasks <папка репозитория задач>');
  const dir = resolve(tasks);
  return {
    tasks: dir,
    only: value('--only')?.split(',').map((s) => s.trim()).filter(Boolean),
    limit: value('--limit') ? Number(value('--limit')) : undefined,
    model: value('--model') ?? 'sonnet',
    jobs: Number(value('--jobs') ?? 4),
    out: resolve(value('--out') ?? join('tmp', 'normalize', basename(dir))),
    write: argv.includes('--write'),
  };
}

interface Candidate {
  path: string;
  slug: string;
  fm: Frontmatter;
  body: string;
  problems: string[];
}

function candidates(dir: string): Candidate[] {
  const active = join(dir, 'active');
  const result: Candidate[] = [];
  for (const name of readdirSync(active).sort()) {
    const path = join(active, name);
    if (!name.endsWith('.md') || name.endsWith('.log.md') || !statSync(path).isFile()) continue;
    const raw = parseTaskDocument(readFileSync(path, 'utf8'));
    const fm = FrontmatterSchema.parse(raw.data);
    if (fm.status === 'in-progress') continue;
    const problems = newBodyProblems(fm.type, raw.body);
    if (problems.length > 0) result.push({ path, slug: name.replace(/\.md$/, ''), fm, body: raw.body, problems });
  }
  return result;
}

// ── проверка ответа ──────────────────────────────────────────────────────

const HEADING = /^#{1,6}\s/;
const CHECKED = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]\s+\S/;
const OPEN = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+\S/;

const contentLines = (body: string): string[] =>
  body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !HEADING.test(l));

const headings = (body: string): string[] => body.split('\n').filter((l) => HEADING.test(l)).map((l) => l.trim());
const count = (body: string, re: RegExp): number => body.split('\n').filter((l) => re.test(l)).length;

interface Verdict {
  violations: string[];
  added: string[];
}

export function verifyRewrite(type: TaskType, fm: Frontmatter, oldBody: string, newBody: string): Verdict {
  const violations: string[] = [];
  // Строка старого текста должна остаться дословно (с точностью до отступа в конце); повторы считаются.
  const pool = new Map<string, number>();
  for (const l of contentLines(newBody)) pool.set(l.trim(), (pool.get(l.trim()) ?? 0) + 1);
  const lost: string[] = [];
  for (const l of contentLines(oldBody)) {
    const k = l.trim();
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else lost.push(k);
  }
  if (lost.length > 0) violations.push(`потеряны или изменены строки старого текста (${lost.length}): ${lost.slice(0, 5).map((l) => `«${l.slice(0, 80)}»`).join('; ')}`);
  if (count(newBody, CHECKED) !== count(oldBody, CHECKED)) violations.push(`отмеченных пунктов было ${count(oldBody, CHECKED)}, стало ${count(newBody, CHECKED)}`);
  if (count(newBody, OPEN) < count(oldBody, OPEN)) violations.push(`неотмеченных пунктов было ${count(oldBody, OPEN)}, стало ${count(newBody, OPEN)}`);
  violations.push(...newBodyProblems(type, newBody));
  const lint = lintTask(serializeTaskDocument(fm, `\n${newBody.trim()}\n`));
  violations.push(...lint.issues.filter((i) => i.level === 'error').map((i) => `линтер: ${i.message}`));
  const added = [...pool.entries()].flatMap(([line, n]) => Array.from({ length: n }, () => line));
  return { violations, added };
}

// ── claude -p ────────────────────────────────────────────────────────────

function prompt(c: Candidate, retry?: string[]): string {
  const { criteria } = SKELETONS[c.fm.type];
  return [
    'Ты переоформляешь постановку задачи в обязательную структуру. Ответь только новым телом задачи между <body> и </body>, без пояснений.',
    '',
    `Тип задачи: ${c.fm.type}. Заголовок: «${c.fm.title}». Суть: «${c.fm.summary}».`,
    'Обязательные разделы (заголовки второго уровня, ровно такими словами):',
    // «Шаги» в шаблоне — по желанию; здесь их нет, иначе модель добавляет раздел с пустой фразой.
    newBodyTemplate(c.fm.type).replace(/\n*## Шаги\n\n[^\n]*/, ''),
    '',
    'Правила:',
    '1. Каждая непустая строка старого текста, кроме заголовков, должна остаться ДОСЛОВНО — символ в символ. Строки можно переносить между разделами и менять порядок; переписывать, сокращать, объединять и удалять нельзя. Отметки [x] и [ ] не трогать.',
    '2. Заголовки старого текста можно переименовать в обязательные разделы, если по смыслу совпадают («Мотивация (WHY)» → «Зачем», «Что (WHAT)» → «Что сделать», «Проблема» → «Что происходит»). Разделы, которым нет пары, оставь со своими заголовками после обязательных.',
    '3. Недостающий обязательный раздел заполни коротко и только тем, что следует из самой задачи; не выдумывай факты, файлы, цифры. Если для раздела в задаче нет сведений — одна честная строка, например «Шаги воспроизведения в задаче не описаны.»',
    criteria
      ? `4. Раздел «${criteria}»: если старый текст уже называет проверяемые результаты, оформи их пунктами «- [ ] …» (это новые строки; старые строки при этом остаются). Если проверяемых результатов в задаче нет — одна строка «${NO_CRITERIA_PREFIX} <почему>», без пунктов.`
      : '4. У спайка раздела критериев нет; «Ответ» не заполняй.',
    '5. Заготовки вида <…> не оставляй. Необязательные разделы («Шаги», «Ответ») не добавляй, если их не было; пустых фраз вида «в задаче не описано» вне обязательных разделов не пиши.',
    '6. Критерий — проверяемый результат для продукта или кода. Не пиши критериев про сам файл задачи, папки, статусы и перенос задачи (inbox, backlog, done, cancelled).',
    ...(retry ? ['', 'Прошлый ответ не принят. Исправь:', ...retry.map((v) => `- ${v}`)] : []),
    '',
    'Старый текст задачи:',
    '<old>',
    c.body.trim(),
    '</old>',
  ].join('\n');
}

const SESSION_VARS = /^(CLAUDE[A-Z_]*|INIT_CWD|KAITEN_[A-Z_]*|npm_[A-Za-z_]*)$/;

function askClaude(text: string, model: string, cwd: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
  return new Promise((resolveAnswer, reject) => {
    const child = spawn(
      'claude',
      // На Windows claude — это .cmd, без оболочки не запустить; оболочка склеивает аргументы, и пустой --tools пропал бы.
      ['-p', '--model', model, '--tools', process.platform === 'win32' ? '""' : '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'],
      { cwd, env, shell: process.platform === 'win32', windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude -p завершился с кодом ${code}: ${err.slice(0, 300)}`));
      try {
        const parsed = JSON.parse(out) as { result?: unknown; is_error?: unknown };
        if (parsed.is_error === true || typeof parsed.result !== 'string') return reject(new Error('claude -p вернул ошибку'));
        resolveAnswer(parsed.result);
      } catch {
        reject(new Error('ответ claude -p не разбирается'));
      }
    });
    child.stdin.end(text, 'utf8');
  });
}

const extractBody = (answer: string): string | null => /<body>\n?([\s\S]*?)\n?<\/body>/.exec(answer)?.[1]?.trim() ?? null;

// ── прогон ───────────────────────────────────────────────────────────────

interface Outcome {
  slug: string;
  type: TaskType;
  status: string;
  ok: boolean;
  attempts: number;
  violations: string[];
  added: string[];
  oldHeadings: string[];
  newHeadings: string[];
  waiver: boolean;
  addedCriteria: number;
}

async function normalizeOne(c: Candidate, args: Args, cwd: string): Promise<Outcome> {
  let retry: string[] | undefined;
  let last: Verdict = { violations: ['нет ответа'], added: [] };
  let body: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      body = extractBody(await askClaude(prompt(c, retry), args.model, cwd));
    } catch (error) {
      last = { violations: [(error as Error).message], added: [] };
      continue;
    }
    if (body === null) {
      last = { violations: ['в ответе нет <body>…</body>'], added: [] };
      retry = last.violations;
      continue;
    }
    last = verifyRewrite(c.fm.type, c.fm, c.body, body);
    writeFileSync(join(args.out, `${c.slug}.md`), `${body}\n`, 'utf8');
    if (last.violations.length === 0) {
      return outcome(c, true, attempt, last, body);
    }
    retry = last.violations;
  }
  return outcome(c, false, 2, last, body ?? '');
}

function outcome(c: Candidate, ok: boolean, attempts: number, v: Verdict, body: string): Outcome {
  return {
    slug: c.slug,
    type: c.fm.type,
    status: c.fm.status,
    ok,
    attempts,
    violations: v.violations,
    added: v.added,
    oldHeadings: headings(c.body),
    newHeadings: headings(body),
    waiver: body.split('\n').some((l) => l.trim().startsWith(NO_CRITERIA_PREFIX)),
    addedCriteria: v.added.filter((l) => OPEN.test(l)).length,
  };
}

async function pool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>, onDone: (r: R, i: number) => void): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
        onDone(results[i], ++done);
      }
    }),
  );
  return results;
}

function report(outcomes: Outcome[], args: Args, total: number): string {
  const ok = outcomes.filter((o) => o.ok);
  const lines = [
    `# Дозаполнение постановки — ${basename(args.tasks)}`,
    '',
    `Открытых задач с нехваткой (без «В работе»): ${total}; в прогоне: ${outcomes.length}; принято: ${ok.length}; человеку: ${outcomes.length - ok.length}.`,
    `Добавлены новые критерии: ${ok.filter((o) => o.addedCriteria > 0).length} задач (${ok.reduce((n, o) => n + o.addedCriteria, 0)} пунктов); «Критериев нет»: ${ok.filter((o) => o.waiver).length}.`,
    '',
  ];
  for (const o of outcomes) {
    lines.push(`## ${o.slug} — ${o.ok ? 'принято' : 'ЧЕЛОВЕКУ'} (${o.type}, ${o.status}, попыток ${o.attempts})`, '');
    lines.push(`Разделы: ${o.oldHeadings.join(' · ') || '—'}`, `→ ${o.newHeadings.join(' · ') || '—'}`, '');
    if (o.violations.length > 0) lines.push('Нарушения:', ...o.violations.map((v) => `- ${v}`), '');
    if (o.added.length > 0) lines.push('Добавлено:', ...o.added.map((a) => `- ${OPEN.test(a) ? '**критерий** ' : ''}${a}`), '');
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let list = candidates(args.tasks);
  const total = list.length;
  if (args.only) list = list.filter((c) => args.only?.includes(c.slug));
  if (args.limit !== undefined) list = list.slice(0, args.limit);
  mkdirSync(args.out, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), 'kaiten-normalize-'));
  console.log(`${args.write ? 'WRITE' : 'DRY-RUN'}: задач с нехваткой ${total}, в прогоне ${list.length}, модель ${args.model}, параллельно ${args.jobs}`);
  const outcomes = await pool(list, args.jobs, (c) => normalizeOne(c, args, cwd), (o, done) => {
    console.log(`  [${done}/${list.length}] ${o.slug}: ${o.ok ? 'принято' : `человеку — ${o.violations[0] ?? ''}`.slice(0, 160)}`);
  });
  writeFileSync(join(args.out, 'REPORT.md'), report(outcomes, args, total), 'utf8');
  if (args.write) {
    const today = taskDate(new Date());
    for (const o of outcomes.filter((x) => x.ok)) {
      const c = list.find((x) => x.slug === o.slug);
      if (!c) continue;
      const body = readFileSync(join(args.out, `${o.slug}.md`), 'utf8').trim();
      writeFileSync(c.path, serializeTaskDocument({ ...c.fm, updated: today, revised: today }, `\n${body}\n`), 'utf8');
    }
  }
  const ok = outcomes.filter((o) => o.ok).length;
  console.log(`Принято ${ok} из ${outcomes.length}${args.write ? ' — записано в репозиторий задач' : ''}. Отчёт: ${join(args.out, 'REPORT.md')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
