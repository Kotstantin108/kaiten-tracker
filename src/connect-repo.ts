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
 *   npm run connect-repo -- <папка репозитория> --project <ключ> --repo <имя> [--push none|branch|pr] [--rules <файл>] [--apply]
 *
 *   --project   проект из tracker.config.json
 *   --repo      репозиторий кода проекта (поле `repo` задач)
 *   --push      что делать с веткой перед ревью (по умолчанию branch: отправить ветку, PR — человек)
 *   --rules     файл правил агента (по умолчанию CLAUDE.md, если есть; иначе AGENTS.md, если есть; иначе новый CLAUDE.md)
 *
 * Коды выхода: 0 — ок; 2 — ошибка аргументов.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.js';
import { planConnect, PROJECT_FILE_PATH, PUSH_POLICIES, SKILL_PATH, type PushPolicy } from './core/repo-connect.js';

const TOOL_SKILL = fileURLToPath(new URL('../skills/kaiten/SKILL.md', import.meta.url));
const CONFIG = fileURLToPath(new URL('../tracker.config.json', import.meta.url));

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { project: { type: 'string' }, repo: { type: 'string' }, push: { type: 'string' }, rules: { type: 'string' }, apply: { type: 'boolean' } },
    allowPositionals: true,
  });
  const dir = positionals[0] ? resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]) : fail('Укажите папку репозитория кода: npm run connect-repo -- <папка> --project <ключ> --repo <имя>');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`Нет папки ${dir}`);
  if (!existsSync(join(dir, '.git'))) fail(`${dir} — не корень репозитория git`);

  const { projects } = loadConfig(CONFIG);
  const key = values.project ?? fail(`Укажите --project (есть: ${Object.keys(projects).join(', ')})`);
  const project = projects[key] ?? fail(`Проекта «${key}» нет в конфиге (есть: ${Object.keys(projects).join(', ')})`);
  const repos = project.repos.map((r) => r.name);
  const repo = values.repo ?? fail(`Укажите --repo (в проекте ${project.title}: ${repos.join(', ')})`);
  if (!repos.includes(repo)) fail(`В проекте ${project.title} нет репозитория «${repo}» (есть: ${repos.join(', ')})`);
  const push = (values.push ?? 'branch') as PushPolicy;
  if (!PUSH_POLICIES.includes(push)) fail(`--push: ${PUSH_POLICIES.join(', ')}`);

  const rulesFile = values.rules ?? (existsSync(join(dir, 'CLAUDE.md')) ? 'CLAUDE.md' : existsSync(join(dir, 'AGENTS.md')) ? 'AGENTS.md' : 'CLAUDE.md');
  const changes = planConnect({
    project: key,
    repo,
    push,
    toolSkill: readFileSync(TOOL_SKILL, 'utf8'),
    rulesFile,
    current: { projectFile: read(join(dir, PROJECT_FILE_PATH)), skill: read(join(dir, SKILL_PATH)), rules: read(join(dir, rulesFile)) },
  });

  console.log(`Репозиторий ${dir} → проект ${project.title} (${key}), продукт ${repo}, правило про ветку: ${push}`);
  console.log(values.apply ? 'APPLY — записываю' : 'DRY-RUN — ничего не записано, только план');
  if (changes.length === 0) {
    console.log('Всё на месте: файл проекта, скилл и блок правил актуальны.');
    return;
  }
  for (const c of changes) console.log(`  ${c.path}: ${c.what}`);
  if (existsSync(join(dir, 'tasks'))) console.log('  В репозитории есть папка tasks/ — скрипт её не трогает: удаление после переезда задач делает владелец.');
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
