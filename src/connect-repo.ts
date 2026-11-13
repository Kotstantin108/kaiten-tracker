/**
 * Скрипт владельца: подключить репозиторий кода к kaiten — или обновить уже
 * подключённый (скилл и блок правил устаревают вместе с инструментом).
 *
 * Не команда `kaiten`: агент не должен «подключать» репозиторий сам (решение
 * владельца 28.09.2026). Пишет три файла (`core/repo-connect.ts`): `.kaiten`,
 * копию скилла и блок правил в `CLAUDE.md`. Не коммитит, ветку не заводит и
 * `tasks/` не трогает — это шаги владельца.
 *
 * БЕЗ `--apply` — только план.
 *
 *   npm run connect-repo -- <папка репозитория> --tasks <репозиторий задач> --repo <имя> [--push none|branch|pr] [--hosting github|gitlab] [--rules <файл>] [--apply]
 *
 *   --tasks     рабочая копия репозитория задач (с kaiten.json) или его адрес (хранилище на этой машине)
 *   --repo      репозиторий кода проекта (поле `repo` задач)
 *   --push      что делать с веткой перед ревью (по умолчанию branch: отправить ветку, PR — человек)
 *   --hosting   где лежит репозиторий кода: от этого зависят слова правила (PR и `gh` или merge request и `glab`).
 *               github.com и gitlab.com узнаются по `origin`; свой сервер — только этим флагом
 *   --rules     файл правил агента (по умолчанию тот, где блок kaiten уже есть; иначе CLAUDE.md, если есть; иначе AGENTS.md; иначе новый CLAUDE.md)
 *
 * Коды выхода: 0 — ок; 2 — ошибка аргументов.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadOwnerProject } from './owner-project.js';
import { gitText } from './task-store.js';
import { HOSTING_TITLE, HOSTINGS, hostingOf, parseRepoAddress, type Hosting } from './core/hosting.js';
import { planConnect, PROJECT_FILE_PATH, PUSH_POLICIES, rulesState, SKILL_PATH, type PushPolicy } from './core/repo-connect.js';

const RULES_FILES = ['CLAUDE.md', 'AGENTS.md'];
const TOOL_SKILL = fileURLToPath(new URL('../skills/kaiten/SKILL.md', import.meta.url));

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Хостинг репозитория кода: флаг, иначе — по `origin`. Свой сервер по адресу
 * не узнать — отказ, а не правило наугад: агент исполнит `gh pr create` и на
 * GitLab. Без `origin` (репозиторий ещё никуда не отправлен) — GitHub, как было.
 */
function codeHosting(flag: string | undefined, origin: string | undefined): Hosting {
  if (flag !== undefined) {
    const named = HOSTINGS.find((h) => h === flag);
    return named ?? fail(`--hosting: ${HOSTINGS.join(', ')}`);
  }
  const address = parseRepoAddress(origin);
  if (!address) return 'github';
  return hostingOf(address) ?? fail(`Репозиторий кода лежит на ${address.host} — по адресу не понять, GitHub это или GitLab. Укажите --hosting ${HOSTINGS.join('|')}`);
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { tasks: { type: 'string' }, repo: { type: 'string' }, push: { type: 'string' }, hosting: { type: 'string' }, rules: { type: 'string' }, apply: { type: 'boolean' } },
    allowPositionals: true,
  });
  const dir = positionals[0] ? resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]) : fail('Укажите папку репозитория кода: npm run connect-repo -- <папка> --tasks <репозиторий задач> --repo <имя>');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`Нет папки ${dir}`);
  if (!existsSync(join(dir, '.git'))) fail(`${dir} — не корень репозитория git`);

  if (!values.tasks) fail('Укажите --tasks <рабочая копия репозитория задач> или --tasks <его адрес>');
  let owner;
  try {
    owner = loadOwnerProject(['--tasks', values.tasks]);
  } catch (error) {
    fail((error as Error).message);
  }
  const { project } = owner.loaded;
  const remote = (from: string): string | undefined => {
    try {
      return gitText(from, ['remote', 'get-url', 'origin']) || undefined;
    } catch {
      return undefined;
    }
  };
  const tasksUrl =
    (owner.source.kind === 'store' ? owner.source.url : (project.tasksRepo?.url ?? (owner.source.kind === 'dir' ? remote(owner.source.dir) : undefined))) ??
    fail('Не понять адрес репозитория задач: задайте tasksRepo.url в kaiten.json или --tasks <адрес>');
  const repos = project.repos.map((r) => r.name);
  const repo = values.repo ?? fail(`Укажите --repo (в проекте ${project.title}: ${repos.join(', ')})`);
  if (!repos.includes(repo)) fail(`В проекте ${project.title} нет репозитория «${repo}» (есть: ${repos.join(', ')})`);
  const push = (values.push ?? 'branch') as PushPolicy;
  if (!PUSH_POLICIES.includes(push)) fail(`--push: ${PUSH_POLICIES.join(', ')}`);
  const hosting = codeHosting(values.hosting, remote(dir));

  // Блок правил уже где-то есть — обновляем его там, а не дописываем второй в CLAUDE.md.
  const withBlock = RULES_FILES.find((name) => rulesState(read(join(dir, name))) !== 'missing');
  const rulesFile = values.rules ?? withBlock ?? RULES_FILES.find((name) => existsSync(join(dir, name))) ?? 'CLAUDE.md';
  const changes = planConnect({
    tasks: tasksUrl,
    repo,
    push,
    hosting,
    toolSkill: readFileSync(TOOL_SKILL, 'utf8'),
    rulesFile,
    current: { projectFile: read(join(dir, PROJECT_FILE_PATH)), skill: read(join(dir, SKILL_PATH)), rules: read(join(dir, rulesFile)) },
  });

  console.log(`Репозиторий ${dir} → проект ${project.title}, продукт ${repo}, задачи ${tasksUrl}, правило про ветку: ${push}, код — на ${HOSTING_TITLE[hosting]}`);
  console.log(values.apply ? 'APPLY — записываю' : 'DRY-RUN — ничего не записано, только план');
  if (changes.length === 0) {
    console.log('Всё на месте: файл проекта, скилл и блок правил актуальны.');
    return;
  }
  for (const c of changes) console.log(`  ${c.path}: ${c.what}`);
  if (existsSync(join(dir, 'tasks'))) console.log('  В репозитории есть папка tasks/ — скрипт её не трогает: удаление после переезда задач делает владелец.');
  // Частый случай: .claude/ целиком в .gitignore — скилл не попадёт в git, и у других его не будет.
  const ignored = spawnSync('git', ['check-ignore', '-q', SKILL_PATH], { cwd: dir, windowsHide: true }).status === 0;
  if (ignored) {
    console.log(
      `  ВНИМАНИЕ: ${SKILL_PATH} попадает под .gitignore — в коммит скилл не войдёт. Замените в .gitignore строку «.claude/» на:\n` +
        '      .claude/*\n      !.claude/skills/\n      .claude/skills/*\n      !.claude/skills/kaiten/',
    );
  }
  if (!values.apply) {
    console.log('Записать: тот же вызов с --apply.');
    return;
  }
  for (const c of changes) {
    const path = join(dir, c.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, c.text, 'utf8');
  }
  console.log(`Записано файлов: ${changes.length}. Дальше — руками: просмотреть diff, закоммитить в ветке проекта, проверить из репозитория: kaiten doctor`);
}

main();
