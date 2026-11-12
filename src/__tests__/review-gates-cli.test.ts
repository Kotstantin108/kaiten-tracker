/**
 * Гейты сдачи сквозь команды: `kaiten verify` запускает проверки проекта в
 * репозитории кода, `kaiten review` принимает работу только с успешным прогоном
 * на текущем коммите и с правкой документации в ветке. Проект без `review` и
 * `domains` ведёт себя как раньше. Git локальный, Kaiten выключен.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTaskDocument, serializeTaskDocument } from '../core/document.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-gates-test-'));
const app = join(tmp, 'app');
const store = join(tmp, 'store.git');
const configPath = join(tmp, 'kaiten.json');
const saved = { cwd: process.cwd(), env: { ...process.env } };

// Пути настроек и конфига читаются при загрузке модулей — задать до импорта.
process.env.KAITEN_STORE = store;
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
process.env.KAITEN_CONFIG = configPath;
process.env.KAITEN_SEND = 'off';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const PLAIN = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [{ name: 'acme-app', label: 'Acme-app' }],
  people: { people: { alice: { name: 'Алиса' } }, emails: {} },
};
// Проверки — команды оболочки из kaiten.json: первая проходит всегда, вторая падает, пока в коммите есть broken.txt.
const GATED = {
  ...PLAIN,
  review: {
    checks: [
      { name: 'typecheck', run: 'node -e "console.log(1)"' },
      { name: 'test', run: 'node check.mjs' },
    ],
    docs: ['docs/**', '**/README.md'],
    testPlan: true,
  },
  domains: { core: 'человек читает изменения целиком', generic: 'пролистать после гейтов' },
};
const useConfig = (config: object): void => writeFileSync(configPath, JSON.stringify(config));

const BODY = '\n## Зачем\n\nНужно.\n\n## Что сделать\n\nСделать.\n\n## Критерии готовности\n\n- [x] Работает\n';
const STARTED = '## [2026-11-12 10:00:00 +03:00 · alice] в работе\n\n## [2026-11-12 10:30:00 +03:00 · alice] Сделал, проверил руками\n';

function task(slug: string, fm: Partial<Frontmatter>): Array<[string, string]> {
  const text = serializeTaskDocument(
    FrontmatterSchema.parse({
      title: `Сделать ${slug}`,
      summary: 'Коротко.',
      type: 'story',
      status: 'in-progress',
      repo: 'acme-app',
      created: '2026-11-01',
      created_by: 'alice',
      updated: '2026-11-01',
      ...fm,
    }),
    BODY,
  );
  return [
    [`active/${slug}.md`, text],
    [`active/${slug}.log.md`, STARTED],
  ];
}

const stored = (path: string): string => git(store, 'show', `main:${path}`);
const fmOf = (slug: string): Frontmatter => FrontmatterSchema.parse(parseTaskDocument(stored(`active/${slug}.md`)).data);
const logOf = (slug: string): string => stored(`active/${slug}.log.md`);
const lastEntry = (slug: string): string => logOf(slug).trim().split('\n').filter((l) => l.startsWith('## [')).at(-1) ?? '';

function commitFile(name: string, content: string, message: string): void {
  mkdirSync(join(app, name, '..'), { recursive: true });
  writeFileSync(join(app, name), content);
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', message);
}

async function refusal(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

beforeAll(() => {
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ sync: { kaiten: false }, person: 'alice' }));
  useConfig(PLAIN);
  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'active'), { recursive: true });
  const files = [
    ...task('plain', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A', branch: 'feature/plain' }),
    ...task('work', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B', branch: 'feature/work', domain: 'core' }),
    ...task('docs', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3C', branch: 'feature/docs' }),
    ...task('answer', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3D', type: 'spike' }),
  ];
  for (const [path, text] of files) writeFileSync(join(seed, path), text);
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'посев');
  git(tmp, 'clone', '-q', '--bare', seed, 'store.git');

  mkdirSync(app);
  git(app, 'init', '-q');
  writeFileSync(join(app, '.kaiten'), 'tasks: https://example.com/acme/acme-tasks.git\nrepo: acme-app\n');
  writeFileSync(join(app, 'check.mjs'), "import { existsSync } from 'node:fs';\nif (existsSync('broken.txt')) { console.log('строка до ошибки'); console.error('FAIL: broken.txt в коммите'); process.exit(1); }\nconsole.log('ok');\n");
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'основа');
  process.chdir(app);
});

afterAll(() => {
  process.chdir(saved.cwd);
  for (const k of ['KAITEN_STORE', 'KAITEN_SETTINGS', 'KAITEN_CONFIG', 'KAITEN_SEND']) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('проект без review и domains ведёт себя как раньше', { timeout: 60_000 }, () => {
  it('review принимает работу без прогона и без документации; запись о сдаче — прежняя', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    git(app, 'switch', '-q', '-c', 'feature/plain');
    commitFile('src/a.txt', 'a\n', 'работа');
    // Незакоммиченное без гейтов не мешает — как раньше.
    writeFileSync(join(app, 'scratch.txt'), 'x\n');
    await WRITE_COMMANDS.review(['plain', '--no-ingest', 'флаг без гейта не мешает']);
    rmSync(join(app, 'scratch.txt'));
    expect(fmOf('plain').status).toBe('review');
    expect(fmOf('plain').checks).toBeUndefined();
    expect(lastEntry('plain')).toMatch(/\] на ревью: ветка feature\/plain, коммит [0-9a-f]+ работа$/);
  });

  it('verify говорит, что запускать нечего, и ничего не пишет', async () => {
    const { verifyTask } = await import('../kaiten-verify.js');
    const { resolveContext } = await import('../kaiten-cli.js');
    const said: string[] = [];
    await verifyTask(resolveContext(), 'work', (line) => said.push(line));
    expect(said).toEqual(['В этом проекте проверки перед ревью не заданы. Запускать нечего.']);
    expect(fmOf('work').checks).toBeUndefined();
  });

  it('--domain отклоняется, шаблон story — без «Как проверить», show и list — без домена', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    const { formatShow, formatTaskLines } = await import('../kaiten-format.js');
    const { domainsOf } = await import('../config.js');
    const { loadTasks, resolveContext } = await import('../kaiten-cli.js');
    expect(await refusal(() => WRITE_COMMANDS.new(['Сделать экспорт', '--type', 'story', '--slug', 'add-export', '--summary', 'Суть.', '--domain', 'core']))).toContain('--domain: в этом проекте домены задач не ведутся');
    const template = await refusal(() => WRITE_COMMANDS.new(['Сделать экспорт', '--type', 'story', '--slug', 'add-export', '--summary', 'Суть.']));
    expect(template).toContain('## Шаги');
    expect(template).not.toContain('Как проверить');
    const ctx = resolveContext();
    const { index } = loadTasks(ctx);
    const work = index.tasks.find((t) => t.slug === 'work');
    if (!work) throw new Error('нет задачи work');
    // У задачи домен записан, но проект домены не ведёт — поля не видно.
    expect(formatShow(index.tasks, work, [], null, domainsOf(ctx.loaded.project))).not.toContain('Домен');
    expect(formatTaskLines(index.tasks, [work], false, domainsOf(ctx.loaded.project))[0]).not.toContain('домен');
  });
});

describe('гейт проверок', { timeout: 120_000 }, () => {
  it('ветка без прогона — review отказывает и называет команду', async () => {
    useConfig(GATED);
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    git(app, 'switch', '-q', 'main');
    git(app, 'switch', '-q', '-c', 'feature/work');
    commitFile('src/work.txt', '1\n', 'работа по задаче');
    const text = await refusal(() => WRITE_COMMANDS.review(['work', '--no-ingest', 'правка опечатки']));
    expect(text).toBe('Не записано: проверки проекта по задаче не запускались. Запустите: kaiten verify work');
    expect(fmOf('work').status).toBe('in-progress');
  });

  it('не та ветка и незакоммиченное — verify не запускается', async () => {
    const { VERIFY_COMMANDS } = await import('../kaiten-verify.js');
    git(app, 'switch', '-q', 'main');
    expect(await refusal(() => VERIFY_COMMANDS.verify(['work']))).toContain('вы на ветке main, а работа по задаче — в ветке feature/work. Переключитесь: git switch feature/work');
    git(app, 'switch', '-q', 'feature/work');
    writeFileSync(join(app, 'draft.txt'), 'x\n');
    const dirty = await refusal(() => VERIFY_COMMANDS.verify(['work']));
    expect(dirty).toContain('незакоммиченные изменения (1):\n  draft.txt');
    expect(dirty).toContain('kaiten verify work');
    rmSync(join(app, 'draft.txt'));
    expect(fmOf('work').checks).toBeUndefined();
  });

  it('успешный прогон: итог и коммит — в задаче и журнале; review на том же коммите принимает', async () => {
    const { VERIFY_COMMANDS, verifyTask } = await import('../kaiten-verify.js');
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    const { resolveContext } = await import('../kaiten-cli.js');
    await VERIFY_COMMANDS.verify(['work']);
    const head = git(app, 'rev-parse', 'HEAD');
    expect(fmOf('work').checks).toEqual({ commit: head, passed: true, names: ['typecheck', 'test'] });
    expect(lastEntry('work')).toMatch(/· alice\] проверки пройдены: typecheck — прошла \([^)]+\), test — прошла \([^)]+\); коммит [0-9a-f]{10}$/);

    // Повтор на том же коммите проверки заново не гоняет.
    const said: string[] = [];
    await verifyTask(resolveContext(), 'work', (line) => said.push(line));
    expect(said.join('\n')).toContain('уже пройдены. Сдавайте работу: kaiten review work');

    // Незакоммиченное — отказ, хотя прогон на этом коммите успешен.
    writeFileSync(join(app, 'draft.txt'), 'x\n');
    expect(await refusal(() => WRITE_COMMANDS.review(['work', '--no-ingest', 'правка опечатки']))).toContain('незакоммиченные изменения');
    rmSync(join(app, 'draft.txt'));

    // Новый коммит после прогона его обесценивает.
    commitFile('src/work.txt', '2\n', 'ещё правка');
    const stale = await refusal(() => WRITE_COMMANDS.review(['work', '--no-ingest', 'правка опечатки']));
    expect(stale).toContain('коммит после прогона его обесценивает. Запустите: kaiten verify work');
    expect(fmOf('work').status).toBe('in-progress');

    await VERIFY_COMMANDS.verify(['work']);
    await WRITE_COMMANDS.review(['work', '--no-ingest', 'правка опечатки']);
    expect(fmOf('work').status).toBe('review');
    const entry = lastEntry('work');
    expect(entry).toContain('на ревью: ветка feature/work, коммит');
    // Домен — в записи о сдаче: ревьюер видит его, не открывая постановку.
    expect(entry).toContain('домен core — человек читает изменения целиком');
    expect(entry).toContain('документация не обновлена: правка опечатки');
    expect(entry).toContain(`проверки пройдены на коммите ${git(app, 'rev-parse', 'HEAD').slice(0, 10)}`);
  });

  it('упавшая проверка: хвост вывода — агенту, в журнале «не прошла», review отказывает', async () => {
    const { VERIFY_COMMANDS } = await import('../kaiten-verify.js');
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    git(app, 'switch', '-q', 'main');
    git(app, 'switch', '-q', '-c', 'feature/docs');
    commitFile('broken.txt', 'x\n', 'сломал');
    const text = await refusal(() => VERIFY_COMMANDS.verify(['docs']));
    expect(text).toContain('Проверка test не прошла. Конец её вывода:');
    expect(text).toContain('FAIL: broken.txt в коммите');
    expect(text).toContain('запустите снова: kaiten verify docs');
    expect(fmOf('docs').checks?.passed).toBe(false);
    const entry = lastEntry('docs');
    expect(entry).toMatch(/проверки не пройдены: typecheck — прошла \([^)]+\), test — не прошла \([^)]+\); коммит/);
    // В журнал — только итог: вывода проверки там нет.
    expect(logOf('docs')).not.toContain('FAIL');
    expect(await refusal(() => WRITE_COMMANDS.review(['docs', '--no-ingest', 'нечего']))).toContain('не прошли. Исправьте, закоммитьте и запустите: kaiten verify docs');
  });
});

describe('гейт документации', { timeout: 120_000 }, () => {
  it('ветка без правок документации — отказ с обоими выходами; с правкой — принято', async () => {
    const { VERIFY_COMMANDS } = await import('../kaiten-verify.js');
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    git(app, 'rm', '-q', 'broken.txt');
    git(app, 'commit', '-q', '-m', 'починил');
    await VERIFY_COMMANDS.verify(['docs']);
    const text = await refusal(() => WRITE_COMMANDS.review(['docs']));
    expect(text).toContain('Не записано: в изменениях ветки нет документации (docs/**, **/README.md).');
    expect(text).toContain('Обновите страницу модуля');
    expect(text).toContain('kaiten review docs --no-ingest "<почему>"');
    expect(fmOf('docs').status).toBe('in-progress');

    commitFile('docs/orders.md', '# Заказы\n', 'страница модуля');
    // Правка документации — новый коммит: проверки нужно повторить.
    expect(await refusal(() => WRITE_COMMANDS.review(['docs']))).toContain('Запустите: kaiten verify docs');
    await VERIFY_COMMANDS.verify(['docs']);
    await WRITE_COMMANDS.review(['docs']);
    expect(fmOf('docs').status).toBe('review');
    expect(lastEntry('docs')).toContain('документация: docs/orders.md');
    // У задачи без домена в записи о сдаче домена нет.
    expect(lastEntry('docs')).not.toContain('домен');
  });

  it('спайку гейты не применяются', async () => {
    const { WRITE_COMMANDS } = await import('../kaiten-write.js');
    const { verifyTask } = await import('../kaiten-verify.js');
    const { resolveContext } = await import('../kaiten-cli.js');
    const said: string[] = [];
    await verifyTask(resolveContext(), 'answer', (line) => said.push(line));
    expect(said.join()).toContain('у задачи типа spike их нет');
    writeFileSync(join(app, 'draft.txt'), 'x\n');
    await WRITE_COMMANDS.review(['answer']);
    rmSync(join(app, 'draft.txt'));
    expect(fmOf('answer').status).toBe('review');
  });
});

describe('kaiten new: «Как проверить» и домен', { timeout: 120_000 }, () => {
  const kaiten = fileURLToPath(new URL('../../bin/kaiten.mjs', import.meta.url));
  const STORY = '## Зачем\n\nНужно.\n\n## Что сделать\n\nСделать.\n\n## Критерии готовности\n\n- [ ] Работает\n';
  const run = (args: string[], input: string): { code: number | null; out: string } => {
    const r = spawnSync(process.execPath, [kaiten, 'new', ...args, '--summary', 'Суть задачи.', '--stdin'], { cwd: app, input, encoding: 'utf8', env: { ...process.env, KAITEN_TOOL_DIR: '' } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('story без «Как проверить» отклоняется, в шаблоне отказа раздел стоит перед «Шаги»', () => {
    const { code, out } = run(['Add export', '--type', 'story'], STORY);
    expect(code).toBe(1);
    expect(out).toContain('нет раздела «Как проверить»');
    expect(out).toContain('--no-test-plan "<почему>"');
    expect(out.indexOf('## Как проверить')).toBeGreaterThan(out.indexOf('## Критерии готовности'));
    expect(out.indexOf('## Как проверить')).toBeLessThan(out.indexOf('## Шаги'));
  });

  it('с разделом — заводится; домен из списка — в задаче; неизвестный — отказ со списком', () => {
    const unknown = run(['Add export', '--type', 'story', '--domain', 'billing'], STORY);
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain('--domain: нет домена «billing». Можно: core, generic.');

    const ok = run(['Add export', '--type', 'story', '--domain', 'generic'], `${STORY}\n## Как проверить\n\nИнтеграционный тест выгрузки; открыть отчёт и сверить сумму.\n`);
    expect(ok.out).toContain('Новая задача add-export.');
    expect(ok.code).toBe(0);
    expect(fmOf('add-export').domain).toBe('generic');
  });

  it('--no-test-plan с причиной — заводится, причина в разделе; tech раздела не требует', () => {
    const waived = run(['Fix label', '--type', 'story', '--no-test-plan', 'только текст кнопки'], STORY);
    expect(waived.out).toContain('Новая задача fix-label.');
    expect(stored('active/fix-label.md')).toContain('## Как проверить\n\nПроверять нечего: только текст кнопки');
    const tech = run(['Bump deps', '--type', 'tech'], STORY);
    expect(tech.out).toContain('Новая задача bump-deps.');
  });
});
