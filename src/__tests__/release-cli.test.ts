/**
 * Журнал выкаток сквозь команду: `kaiten release` на настоящих локальных
 * репозиториях git (origin — голый репозиторий рядом) и поддельном Kaiten.
 * Проверяется то, что обещано владельцу: сухой прогон ничего не пишет, слова —
 * только из словарей, копия записи — в теге, повреждённая страница не
 * дописывается и восстанавливается из тегов, выкатка в обход команды держит
 * работу, пока её не записали.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PMNode } from '../agent-server/prosemirror.js';
import { serializeTaskDocument } from '../core/document.js';
import { pageNodes, readPage, type ReleaseRow } from '../core/release.js';
import { FrontmatterSchema, type Frontmatter } from '../core/schema.js';
import { KaitenClient } from '../kaiten-client.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-release-test-'));
const app = join(tmp, 'app');
const landing = join(tmp, 'landing');
const store = join(tmp, 'store.git');
const configPath = join(tmp, 'kaiten.json');
const saved = { cwd: process.cwd(), env: { ...process.env } };
const PAGE = 'journal-page';

process.env.KAITEN_STORE = store;
process.env.KAITEN_SETTINGS = join(tmp, 'settings.json');
process.env.KAITEN_CONFIG = configPath;
process.env.KAITEN_SEND = 'off';
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'test';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'test@example.com';

/** Время в git — управляемое: по нему команда решает, свежая выкатка или давняя. */
function git(cwd: string, at: string | null, ...args: string[]): string {
  const env = at ? { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : process.env;
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const CONFIG = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [
    { name: 'acme-app', label: 'Acme-app', release: { surface: 'продукт', versions: 'tags', changelog: 'docs/CHANGELOG.md' } },
    { name: 'acme-landing', label: 'Acme-landing', release: { surface: 'лендинг', versions: 'calendar' } },
  ],
  releases: { page: PAGE, zones: ['пейволл', 'главная', 'прочее'], types: ['новое', 'исправление', 'техническое'], cardProperty: 77 },
  people: { people: { alice: { name: 'Алиса' } }, emails: {} },
};

const BODY = '\n## Зачем\n\nНужно.\n\n## Что сделать\n\nСделать.\n\n## Критерии готовности\n\n- [x] Работает\n';

function task(slug: string, fm: Partial<Frontmatter>): [string, string] {
  return [
    `active/${slug}.md`,
    serializeTaskDocument(FrontmatterSchema.parse({ title: `Сделать ${slug}`, summary: 'Коротко.', type: 'story', status: 'in-progress', created: '2026-11-01', created_by: 'alice', updated: '2026-11-01', ...fm }), BODY),
  ];
}

// ── поддельный Kaiten: одна страница ─────────────────────────────────────

const doc = { uid: PAGE, title: 'Журнал выкаток', data: JSON.stringify({ type: 'doc', content: [] }) };
const writes: string[] = [];
/** Поле «Релиз» (id 77) на карточках: что записано последним. */
const cardMarks = new Map<number, string | null>();
/** Kaiten перестал принимать запись: чтение работает, `PATCH` — 503. */
let kaitenDown = false;
const fetchImpl: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname.replace('/api/latest', '');
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const card = /^\/cards\/(\d+)$/.exec(path);
  if (card && method === 'GET') return json({ id: Number(card[1]), properties: { id_77: cardMarks.get(Number(card[1])) ?? null } });
  if (card && method === 'PATCH') {
    const properties = (JSON.parse(String(init?.body)) as { properties: Record<string, unknown> }).properties;
    cardMarks.set(Number(card[1]), properties.id_77 as string | null);
    return json({ id: Number(card[1]) });
  }
  if (path !== `/documents/${PAGE}`) return json({ message: 'нет' }, 404);
  if (method === 'PATCH' && kaitenDown && !card) return json({ message: 'сбой' }, 503);
  if (method === 'PATCH') {
    doc.data = JSON.stringify((JSON.parse(String(init?.body)) as { data: unknown }).data);
    writes.push(`PATCH ${path}`);
  }
  return json(doc);
};
const client = new KaitenClient({ domain: 'example.kaiten.ru', token: 't', fetchImpl, maxRetries: 0, sleep: async () => undefined });

const pageContent = (): PMNode[] => (JSON.parse(doc.data) as { content: PMNode[] }).content;
const pageRows = (): ReleaseRow[] => {
  const page = readPage(pageContent());
  if (page.state !== 'ok') throw new Error(`страница: ${page.state}`);
  return page.rows;
};
const setPage = (content: PMNode[]): void => {
  doc.data = JSON.stringify({ type: 'doc', content });
};

// ── запуск команды ───────────────────────────────────────────────────────

interface Run {
  said: string;
  refusal: string;
}

/** `kaiten release` из папки репозитория; `at` — «сейчас» и для команды, и для тега записи. */
async function release(dir: string, at: string, given: Record<string, string | boolean>, input?: string): Promise<Run> {
  const named = dir === landing && input !== undefined && given.title === undefined;
  const { untitled: _untitled, ...rest } = given;
  const flags: Record<string, string | boolean> = named && !given.untitled ? { ...rest, title: 'Правки лендинга' } : rest;
  const { releaseCommand } = await import('../kaiten-release.js');
  const { resolveContext } = await import('../kaiten-cli.js');
  process.chdir(dir);
  process.env.GIT_COMMITTER_DATE = at;
  const said: string[] = [];
  let refusal = '';
  try {
    await releaseCommand(resolveContext(), { ...flags, ...(input !== undefined ? { stdin: true } : {}) }, { client, now: new Date(at), input, say: (line) => said.push(line) });
  } catch (error) {
    refusal = (error as Error).message;
  } finally {
    delete process.env.GIT_COMMITTER_DATE;
  }
  return { said: said.join('\n'), refusal };
}

async function gate(dir: string, at: string): Promise<string | null> {
  const { releaseGateProblem } = await import('../kaiten-release.js');
  const { resolveContext } = await import('../kaiten-cli.js');
  process.chdir(dir);
  return releaseGateProblem(resolveContext(), new Date(at));
}

/** Проверки журнала в `kaiten doctor`, без связи с Kaiten: страницу он тогда не читает. */
async function doctorChecks(dir: string, at: string): Promise<Array<{ level: string; what: string; fix?: string }>> {
  const { releaseChecks } = await import('../kaiten-doctor.js');
  const name = dir === app ? 'acme-app' : 'acme-landing';
  return releaseChecks(dir, { store, repo: name, tasksUrl: 'https://example.com/acme/acme-tasks.git' }, null, true, new Date(at));
}

const originTags =(dir: string): string[] => git(dir, null, 'ls-remote', '--tags', '--refs', 'origin', 'refs/tags/released/*').split('\n').filter(Boolean).map((l) => l.split('refs/tags/')[1]);

function commitFile(dir: string, at: string, name: string, message: string): void {
  writeFileSync(join(dir, name), `${message}\n`);
  git(dir, at, 'add', '-A');
  git(dir, at, 'commit', '-q', '-m', message);
}

/** Ветка задачи с одним коммитом, влитая в main обычным merge-коммитом. */
function mergeFeature(dir: string, at: string, branch: string): void {
  git(dir, at, 'switch', '-q', '-c', branch, 'main');
  commitFile(dir, at, `${branch.replaceAll('/', '-')}.txt`, `работа ${branch}`);
  git(dir, at, 'switch', '-q', 'main');
  git(dir, at, 'merge', '-q', '--no-ff', branch, '-m', `Merge branch '${branch}'`);
}

function initRepo(dir: string, name: string, at: string): void {
  mkdirSync(dir);
  git(dir, at, 'init', '-q');
  writeFileSync(join(dir, '.kaiten'), `tasks: https://example.com/acme/acme-tasks.git\nrepo: ${name}\n`);
  git(dir, at, 'add', '-A');
  git(dir, at, 'commit', '-q', '-m', 'основа');
  git(tmp, null, 'init', '-q', '--bare', `${name}-origin.git`);
  git(dir, null, 'remote', 'add', 'origin', join(tmp, `${name}-origin.git`));
}

const D0 = '2026-10-01T10:00:00+03:00';
const T1150 = '2026-11-19T11:50:00+03:00';
const NOON = '2026-11-19T12:00:00+03:00';

beforeAll(() => {
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ sync: { kaiten: false }, person: 'alice' }));
  writeFileSync(configPath, JSON.stringify(CONFIG));
  const seed = join(tmp, 'seed');
  mkdirSync(join(seed, 'active'), { recursive: true });
  const tasks = [
    task('pay', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3A', repo: 'acme-app', tracker: '101', branch: 'feature/101-pay' }),
    task('fix-login', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3B', repo: 'acme-app', tracker: '102' }),
    task('hero', { id: '01K5ZQ3R8F2K9M4N7P0T5V8W3C', repo: 'acme-landing', tracker: '202' }),
  ];
  for (const [path, text] of tasks) writeFileSync(join(seed, path), text);
  // `kaiten doctor` читает описание проекта из самих задач, а не из KAITEN_CONFIG.
  writeFileSync(join(seed, 'kaiten.json'), JSON.stringify(CONFIG));
  git(seed, null, 'init', '-q');
  git(seed, null, 'add', '-A');
  git(seed, null, 'commit', '-q', '-m', 'посев');
  git(tmp, null, 'clone', '-q', '--bare', seed, 'store.git');

  // Продукт: версии тегами, ветка прода догоняет main.
  initRepo(app, 'acme-app', D0);
  mkdirSync(join(app, 'docs'));
  writeFileSync(
    join(app, 'docs', 'CHANGELOG.md'),
    ['# Changelog', '', '## v1.2.0 — 2026-11-19 — Вход по ссылке', '- Вход по ссылке из письма работает', '', '## v1.1.0 — 2026-11-19 — Оплата в окне', '', '### Тарифы', '- **Цена годового тарифа видна до оплаты.** Раньше её', '  показывали на последнем шаге.', '', '## v1.0.0 — 2026-10-01 — Первая версия', '- Первая версия', ''].join('\n'),
  );
  git(app, D0, 'add', '-A');
  git(app, D0, 'commit', '-q', '-m', 'docs: список изменений');
  git(app, null, 'push', '-q', 'origin', 'main');
  git(app, D0, 'tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0');
  git(app, D0, 'tag', 'vendor-backup');
  mergeFeature(app, T1150, 'feature/101-pay');
  mergeFeature(app, T1150, 'feature/no-task');
  git(app, T1150, 'tag', '-a', 'v1.1.0', '-m', 'Release v1.1.0 — оплата');
  git(app, null, 'branch', '-f', 'production', 'main');
  git(app, null, 'push', '-q', 'origin', 'main', 'production', '--tags');

  // Лендинг: версий нет, выкатка — merge main в production.
  initRepo(landing, 'acme-landing', D0);
  git(landing, null, 'branch', 'production');
  mergeFeature(landing, T1150, 'feature/202-hero');
  git(landing, null, 'switch', '-q', 'production');
  git(landing, T1150, 'merge', '-q', '--no-ff', 'main', '-m', "Merge branch 'main' into production");
  git(landing, null, 'switch', '-q', 'main');
  git(landing, null, 'push', '-q', 'origin', 'main', 'production');
}, 120_000);

afterAll(() => {
  process.chdir(saved.cwd);
  for (const k of ['KAITEN_STORE', 'KAITEN_SETTINGS', 'KAITEN_CONFIG', 'KAITEN_SEND']) {
    if (saved.env[k] === undefined) delete process.env[k];
    else process.env[k] = saved.env[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const LINES_110 = '101 | пейволл | новое | Тарифы | Цена годового тарифа видна до оплаты\n- | прочее | техническое | - | Обновление зависимостей\n';

describe('продукт: выкатка — тег версии', { timeout: 120_000 }, () => {
  it('несколько версий без записи — команда просит назвать версию', async () => {
    const run = await release(app, NOON, {});
    expect(run.refusal).toContain('Не записано выкаток: 2');
    expect(run.refusal).toContain('v1.0.0');
    expect(run.refusal).toContain('v1.1.0');
    expect(run.refusal).not.toContain('vendor-backup');
  });

  it('без строк — показывает выкатку, её задачи, ветки без задачи и словари; ничего не пишет', async () => {
    const run = await release(app, NOON, { version: 'v1.1.0' });
    expect(run.refusal).toBe('');
    expect(run.said).toContain('Выкатка: продукт v1.1.0');
    expect(run.said).toContain('время записи 2026-11-19T12:00+03:00');
    expect(run.said).toContain('Изменения — с v1.0.0.');
    expect(run.said).toContain('101  story  Сделать pay');
    expect(run.said).toContain('Влитые ветки без задачи: feature/no-task.');
    expect(run.said).toContain("kaiten release --version v1.1.0 --stdin <<'EOF'");
    expect(run.said).toContain('Название: Оплата в окне');
    expect(run.said).toContain('- | <зона> | <тип> | Тарифы | **Цена годового тарифа видна до оплаты.** Раньше её показывали на последнем шаге.');
    expect(run.said).toContain('101 | <зона> | <тип> | - | <что изменилось для пользователя — если задачи нет в пунктах выше>');
    expect(run.said).toContain('Зоны: пейволл, главная, прочее.');
    expect(run.said).toContain('Ничего не записано.');
    expect(writes).toEqual([]);
    expect(originTags(app)).toEqual([]);
  });

  it('слово не из словаря и задача без строки — отказ до записи', async () => {
    const wrong = await release(app, NOON, { version: 'v1.1.0', apply: true }, '101 | оплата | новое | - | Текст\n');
    expect(wrong.refusal).toContain('нет зоны «оплата». Можно: пейволл, главная, прочее');
    const uncovered = await release(app, NOON, { version: 'v1.1.0', apply: true }, '- | прочее | техническое | - | Обновление зависимостей\n');
    expect(uncovered.refusal).toContain('задача 101 вошла в выкатку, а строки о ней нет');
    const foreign = await release(app, NOON, { version: 'v1.1.0', apply: true }, `${LINES_110}999 | прочее | новое | - | Текст\n`);
    expect(foreign.refusal).toContain('строка 3:');
    expect(writes).toEqual([]);
    expect(originTags(app)).toEqual([]);
  });

  it('со строками, но без --apply — показывает строки и ничего не пишет', async () => {
    const run = await release(app, NOON, { version: 'v1.1.0' }, LINES_110);
    expect(run.refusal).toBe('');
    expect(run.said).toContain('| 2026-11-19T12:00+03:00 | продукт | v1.1.0 | Оплата в окне | релиз | пейволл | Тарифы | новое | 101 | Цена годового тарифа видна до оплаты |');
    expect(run.said).toContain('Карточкам задач будет записано поле «Релиз»: 101 — продукт v1.1.0.');
    expect(run.said).toContain('Ничего не записано. Записать: kaiten release --version v1.1.0 --stdin --apply');
    expect(cardMarks.size).toBe(0);
    expect(writes).toEqual([]);
    expect(originTags(app)).toEqual([]);
  });

  it('--apply: строки на странице, копия записи — в теге в origin', async () => {
    const run = await release(app, NOON, { version: 'v1.1.0', apply: true }, LINES_110);
    expect(run.refusal).toBe('');
    expect(run.said).toContain('Записано: релиз продукт v1.1.0, строк 2. Копия записи — в теге released/v1.1.0.');
    expect(pageRows()).toEqual([
      { at: '2026-11-19T12:00+03:00', surface: 'продукт', version: 'v1.1.0', title: 'Оплата в окне', event: 'релиз', zone: 'пейволл', section: 'Тарифы', type: 'новое', task: '101', text: 'Цена годового тарифа видна до оплаты' },
      { at: '2026-11-19T12:00+03:00', surface: 'продукт', version: 'v1.1.0', title: 'Оплата в окне', event: 'релиз', zone: 'прочее', section: '—', type: 'техническое', task: '—', text: 'Обновление зависимостей' },
    ]);
    expect(originTags(app)).toEqual(['released/v1.1.0']);
    expect(git(app, null, 'rev-parse', 'released/v1.1.0^{commit}')).toBe(git(app, null, 'rev-parse', 'v1.1.0^{commit}'));
    expect(run.said).toContain('Поле «Релиз» записано карточкам: 1.');
    expect(cardMarks.get(101)).toBe('продукт v1.1.0');
    expect(git(app, null, 'tag', '-l', '--format=%(contents)', 'released/v1.1.0')).toContain('kaiten-release: {"v":2,"surface":"продукт","version":"v1.1.0","title":"Оплата в окне"');
  });

  it('записанную версию второй раз не записать; в истории остаётся v1.0.0', async () => {
    expect((await release(app, NOON, { version: 'v1.1.0', apply: true }, LINES_110)).refusal).toContain('Версия v1.1.0 уже записана');
    const run = await release(app, NOON, {});
    expect(run.said).toContain('Новых выкаток нет. В истории без записи: 1');
    expect(run.said).toContain('v1.0.0');
  });

  it('давняя выкатка: без выбора — отказ; --missed берёт время из тега и помечает его', async () => {
    const lines = '- | прочее | новое | - | Первая версия\n';
    expect((await release(app, NOON, { version: 'v1.0.0', apply: true }, lines)).refusal).toContain('добавьте --missed');
    const run = await release(app, NOON, { version: 'v1.0.0', missed: true, apply: true }, lines);
    expect(run.refusal).toBe('');
    expect(pageRows().map((r) => `${r.at} ${r.version}`)).toEqual(['2026-11-19T12:00+03:00 v1.1.0', '2026-11-19T12:00+03:00 v1.1.0', '≈2026-10-01T10:00+03:00 v1.0.0']);
    expect((await release(app, NOON, {})).said).toBe('Все выкатки этого репозитория записаны.');
  });

  it('выкатка в обход команды: свежая работу не держит, давняя — держит, пока не записана', async () => {
    mergeFeature(app, '2026-11-19T12:30:00+03:00', 'feature/102-fix-login');
    git(app, '2026-11-19T12:30:00+03:00', 'tag', '-a', 'v1.2.0', '-m', 'Release v1.2.0');
    git(app, null, 'branch', '-f', 'production', 'main');
    git(app, null, 'push', '-q', 'origin', 'main', 'production', 'v1.2.0');
    expect(await gate(app, '2026-11-19T12:40:00+03:00')).toBeNull();
    expect(await doctorChecks(app, '2026-11-19T12:40:00+03:00')).toEqual([{ level: 'warn', what: 'последняя выкатка ещё не записана в журнал выкаток', fix: 'kaiten release — когда прод обновился.' }]);
    expect(await doctorChecks(app, '2026-11-19T15:00:00+03:00')).toEqual([{ level: 'fail', what: expect.stringContaining('в проде есть выкатка без записи'), fix: expect.stringContaining('kaiten release --missed') }]);
    const held = await gate(app, '2026-11-19T15:00:00+03:00');
    expect(held).toContain('в проде есть выкатка без записи в журнале выкаток');
    expect(held).toContain('v1.2.0 — 2026-11-19T12:30+03:00');
    expect(held).toContain('kaiten release --missed');

    const lines = '102 | прочее | исправление | - | Вход по ссылке из письма работает\n';
    expect((await release(app, '2026-11-19T15:00:00+03:00', { apply: true }, lines)).refusal).toContain('добавьте --now');
    const run = await release(app, '2026-11-19T15:00:00+03:00', { now: true, apply: true }, lines);
    expect(run.refusal).toBe('');
    expect(pageRows()[0]).toMatchObject({ at: '2026-11-19T15:00+03:00', version: 'v1.2.0', title: 'Вход по ссылке', task: '102' });
    expect(cardMarks.get(102)).toBe('продукт v1.2.0');
    expect(await gate(app, '2026-11-19T15:00:00+03:00')).toBeNull();
    expect(await doctorChecks(app, '2026-11-19T15:00:00+03:00')).toEqual([{ level: 'ok', what: 'выкатки записаны в журнал: последняя запись — v1.2.0' }]);
  });
});

describe('лендинг: версию выдаёт запись', { timeout: 120_000 }, () => {
  it('без названия выкатка не записывается: списка изменений у репозитория нет', async () => {
    const dry = await release(landing, NOON, {});
    expect(dry.said).toContain('Названия у выкатки нет — добавьте --title');
    expect(dry.said).toContain('kaiten release --title "<название>" --stdin');
    const run = await release(landing, NOON, { untitled: true, apply: true }, '202 | главная | новое | - | Новый первый экран\n');
    expect(run.refusal).toContain('у выкатки нет названия — добавьте --title');
    expect(originTags(landing)).toEqual([]);
  });

  it('--version здесь отклоняется', async () => {
    expect((await release(landing, NOON, { version: '1.0' })).refusal).toContain('версию этого репозитория выдаёт запись');
  });

  it('запись выдаёт календарную версию, ставит тег и пишет в ту же таблицу', async () => {
    const dry = await release(landing, NOON, {});
    expect(dry.said).toContain('Выкатка: лендинг 2026.11.19.1');
    expect(dry.said).toContain('202  story  Сделать hero');
    expect(dry.said).not.toContain('Влитые ветки без задачи');
    const run = await release(landing, NOON, { apply: true }, '202 | главная | новое | - | Новый первый экран\n');
    expect(run.refusal).toBe('');
    expect(originTags(landing)).toEqual(['released/2026.11.19.1']);
    expect(pageRows().find((r) => r.surface === 'лендинг')).toMatchObject({ title: 'Правки лендинга', section: '—' });
    expect(cardMarks.get(202)).toBe('лендинг 2026.11.19.1');
    expect(git(landing, null, 'rev-parse', 'released/2026.11.19.1^{commit}')).toBe(git(landing, null, 'rev-parse', 'origin/production'));
    // 12:00 лендинга — между записями продукта 15:00 и 12:00: строки идут по времени.
    expect(pageRows().map((r) => `${r.surface} ${r.version}`)).toEqual(['продукт v1.2.0', 'продукт v1.1.0', 'продукт v1.1.0', 'лендинг 2026.11.19.1', 'продукт v1.0.0']);
    expect((await release(landing, NOON, {})).said).toBe('Все выкатки этого репозитория записаны.');
  });

  it('вторая выкатка за день — номер 2; несколько выкаток без записи закрываются одной', async () => {
    for (const at of ['2026-11-19T12:10:00+03:00', '2026-11-19T12:20:00+03:00']) {
      commitFile(landing, at, `main-${at.slice(14, 16)}.txt`, `правка ${at.slice(11, 16)}`);
      git(landing, null, 'switch', '-q', 'production');
      git(landing, at, 'merge', '-q', '--no-ff', 'main', '-m', "Merge branch 'main' into production");
      git(landing, null, 'switch', '-q', 'main');
    }
    git(landing, null, 'push', '-q', 'origin', 'main', 'production');
    const at = '2026-11-19T12:25:00+03:00';
    const dry = await release(landing, at, {});
    expect(dry.said).toContain('Выкатка: лендинг 2026.11.19.2');
    expect(dry.said).toContain('С прошлой записи в ветке прода выкаток: 2');
    expect(dry.said).toContain('Изменения — с 2026.11.19.1.');
    const run = await release(landing, at, { apply: true }, '- | главная | исправление | - | Правки текста\n');
    expect(run.refusal).toBe('');
    expect(originTags(landing)).toEqual(['released/2026.11.19.1', 'released/2026.11.19.2']);
  });
});

describe('страница повреждена или запись оборвалась', { timeout: 120_000 }, () => {
  it('в задвоенную страницу команда не пишет; --rebuild возвращает её целой', async () => {
    const before = pageRows();
    setPage([...pageContent(), ...pageContent()]);
    commitFile(landing, '2026-11-19T13:00:00+03:00', 'main-13.txt', 'правка 13:00');
    git(landing, null, 'switch', '-q', 'production');
    git(landing, '2026-11-19T13:00:00+03:00', 'merge', '-q', '--no-ff', 'main', '-m', "Merge branch 'main' into production");
    git(landing, null, 'switch', '-q', 'main');
    git(landing, null, 'push', '-q', 'origin', 'main', 'production');
    const written = writes.length;
    const refused = await release(landing, '2026-11-19T13:05:00+03:00', { apply: true }, '- | главная | исправление | - | Ещё правка\n');
    expect(refused.refusal).toContain('страница журнала выкаток повреждена — на странице 2 таблицы вместо одной');
    expect(refused.refusal).toContain('kaiten release --rebuild');
    expect(writes.length).toBe(written);
    expect(originTags(landing)).toHaveLength(2);

    const dry = await release(landing, '2026-11-19T13:05:00+03:00', { rebuild: true });
    expect(dry.said).toContain('Страница журнала повреждена');
    expect(dry.said).toContain('Ничего не записано.');
    expect(writes.length).toBe(written);
    const run = await release(landing, '2026-11-19T13:05:00+03:00', { rebuild: true, apply: true });
    expect(run.refusal).toBe('');
    expect(pageRows()).toEqual(before);
    expect((await release(landing, '2026-11-19T13:05:00+03:00', { apply: true }, '- | главная | исправление | - | Ещё правка\n')).refusal).toBe('');
  });

  it('очищенная страница восстанавливается из тегов каждого репозитория', async () => {
    const before = pageRows();
    setPage([]);
    const first = await release(app, '2026-11-19T15:10:00+03:00', { rebuild: true, apply: true });
    expect(first.said).toContain('Записей этого репозитория (продукт): 3');
    expect(pageRows().every((r) => r.surface === 'продукт')).toBe(true);
    await release(landing, '2026-11-19T15:10:00+03:00', { rebuild: true, apply: true });
    expect(pageRows()).toEqual(before);
    expect((await release(landing, '2026-11-19T15:10:00+03:00', { rebuild: true })).said).toContain('Страница в порядке, восстанавливать нечего.');
  });

  it('Kaiten отказал после отправки тега — запись дописывается из тега', async () => {
    const before = pageRows();
    kaitenDown = true;
    const at = '2026-11-19T15:15:00+03:00';
    const half = await release(landing, at, { rollback: '2026.11.19.2', reason: 'Сломана вёрстка главной', apply: true });
    kaitenDown = false;
    expect(half.refusal).toContain('Запись сделана наполовину: тег released/2026.11.19.2-rollback отправлен, а страница журнала не обновлена');
    expect(half.refusal).toContain('kaiten release --rebuild --apply');
    expect(pageRows()).toEqual(before);
    const run = await release(landing, at, { rebuild: true, apply: true });
    expect(run.said).toContain('На страницу вернётся строк: 1');
    expect(pageRows()).toHaveLength(before.length + 1);
    expect(pageRows().find((r) => r.event === 'откат')).toMatchObject({ surface: 'лендинг', version: '2026.11.19.2', text: 'Сломана вёрстка главной' });
  });

  it('строки, молча пропавшие со страницы, возвращаются со следующей записью', async () => {
    const before = pageRows();
    // Открытый редактор вернул странице старое состояние: она цела, но записей лендинга на ней нет.
    setPage(pageNodes(before.filter((r) => r.surface !== 'лендинг')));
    const { recordsMissingOnPage, readFacts } = await import('../kaiten-release.js');
    const facts = readFacts(landing, { surface: 'лендинг', branch: 'production', versions: 'calendar', tagPrefix: 'v' }, 'no');
    if ('error' in facts) throw new Error(facts.error);
    expect(recordsMissingOnPage('лендинг', facts.recorded, pageRows()).sort()).toEqual(['2026.11.19.1', '2026.11.19.2', '2026.11.19.3', 'откат 2026.11.19.2']);

    const at = '2026-11-19T15:18:00+03:00';
    const run = await release(landing, at, { rollback: '2026.11.19.3', reason: 'Проверка', apply: true });
    expect(run.refusal).toBe('');
    expect(run.said).toContain(`На страницу возвращено строк прежних записей: ${before.filter((r) => r.surface === 'лендинг').length}`);
    expect(pageRows()).toHaveLength(before.length + 1);
    expect(recordsMissingOnPage('лендинг', facts.recorded, pageRows())).toEqual([]);
  });

  it('страница с чужим содержимым не дописывается', async () => {
    const good = pageContent();
    setPage([...good, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Мои заметки' }] }]);
    const refused = await release(app, '2026-11-19T15:20:00+03:00', { rollback: 'v1.2.0', reason: 'проверка' });
    expect(refused.refusal).toContain('после таблицы журнала есть другое содержимое');
    setPage(good);
  });
});

describe('откат', { timeout: 120_000 }, () => {
  it('ветку прода вернули назад без записи — работа стоит, пока откат не записан', async () => {
    git(app, null, 'push', '-q', '--force', 'origin', `${git(app, null, 'rev-parse', 'v1.1.0^{commit}')}:refs/heads/production`);
    const at = '2026-11-19T16:00:00+03:00';
    const held = await gate(app, at);
    expect(held).toContain('ветку прода откатили с версии v1.2.0');
    expect(held).toContain('kaiten release --rollback v1.2.0');

    expect((await release(app, at, { rollback: 'v1.2.0', apply: true })).refusal).toContain('Скажите, почему откатили');
    expect((await release(app, at, { rollback: 'v9.9.9', reason: 'x', apply: true })).refusal).toContain('нет среди записанных выкаток');
    const run = await release(app, at, { rollback: 'v1.2.0', reason: 'Не проходит вход по ссылке', apply: true });
    expect(run.refusal).toBe('');
    expect(pageRows()[0]).toEqual({ at: '2026-11-19T16:00+03:00', surface: 'продукт', version: 'v1.2.0', title: 'Вход по ссылке', event: 'откат', zone: '—', section: '—', type: '—', task: '—', text: 'Не проходит вход по ссылке' });
    expect(originTags(app)).toContain('released/v1.2.0-rollback');
    expect(await gate(app, at)).toBeNull();
  });
});

describe('правка сделанной записи', { timeout: 120_000 }, () => {
  const taggedAt = (): number => Date.parse(git(app, null, "for-each-ref", "--format=%(taggerdate:iso-strict)", "refs/tags/released/v1.1.0"));

  it('--amend заменяет строки и название, а время, коммит и дата записи остаются', async () => {
    const before = pageRows();
    const tags = originTags(app);
    const recordedAt = taggedAt();
    const at = '2026-11-20T10:00:00+03:00';
    expect((await release(app, at, { amend: true }, LINES_110)).refusal).toContain('kaiten release --amend --version <версия> --stdin');
    expect((await release(app, at, { amend: true, version: 'v7.0.0' }, LINES_110)).refusal).toContain('править нечего');

    const lines = '101 | пейволл | исправление | Тарифы | Цена годового тарифа видна сразу\n';
    const dry = await release(app, at, { amend: true, version: 'v1.1.0', title: 'Оплата в окне, уточнение' }, lines);
    expect(dry.said).toContain('Правка записи: продукт v1.1.0');
    expect(dry.said).toContain('время записи 2026-11-19T12:00+03:00');
    expect(pageRows()).toEqual(before);

    const run = await release(app, at, { amend: true, version: 'v1.1.0', title: 'Оплата в окне, уточнение', apply: true }, lines);
    expect(run.refusal).toBe('');
    expect(run.said).toContain('Запись исправлена: релиз продукт v1.1.0, строк 1.');
    expect(pageRows().filter((r) => r.version === 'v1.1.0' && r.event === 'релиз')).toEqual([
      { at: '2026-11-19T12:00+03:00', surface: 'продукт', version: 'v1.1.0', title: 'Оплата в окне, уточнение', event: 'релиз', zone: 'пейволл', section: 'Тарифы', type: 'исправление', task: '101', text: 'Цена годового тарифа видна сразу' },
    ]);
    // Остальные записи на месте: исчезла одна строка прежней записи.
    expect(pageRows()).toHaveLength(before.length - 1);
    expect(originTags(app)).toEqual(tags);
    expect(taggedAt()).toBe(recordedAt);
    expect(git(app, null, 'ls-remote', '--tags', 'origin', 'refs/tags/released/v1.1.0').split('\t')[0]).toBe(git(app, null, 'rev-parse', 'refs/tags/released/v1.1.0'));
    expect(git(app, null, 'tag', '-l', '--format=%(contents)', 'released/v1.1.0')).toContain('"title":"Оплата в окне, уточнение"');
    expect(cardMarks.get(101)).toBe('продукт v1.1.0');
  });

  it('--rebuild проставляет поле «Релиз» карточкам всех записей; версии другого репозитория в поле остаются', async () => {
    cardMarks.clear();
    cardMarks.set(202, 'продукт v9.0.0; лендинг 2020.01.01.1');
    await release(landing, '2026-11-20T10:04:00+03:00', { rebuild: true, apply: true });
    expect(cardMarks.get(202)).toBe('лендинг 2026.11.19.1; продукт v9.0.0');
    cardMarks.clear();
    const run = await release(landing, '2026-11-20T10:05:00+03:00', { rebuild: true, apply: true });
    expect(run.said).toContain('Страница в порядке, восстанавливать нечего.');
    expect(run.said).toContain('Поле «Релиз» записано карточкам: 1.');
    expect(cardMarks.get(202)).toBe('лендинг 2026.11.19.1');
  });
});
