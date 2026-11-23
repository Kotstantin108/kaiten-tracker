/**
 * Линтер репозитория задач v2: проверяет все файлы `active/*.md` и
 * `archive/YYYY-MM/*.md` (журналы `*.log.md` — нет). Только чтение.
 *
 * ФЛАГИ
 *   <dir>              корень репозитория задач (по умолч. `TASKS_DIR`); если в
 *                      нём есть `kaiten.json` — `repo` задач сверяется с
 *                      репозиториями проекта и сам `kaiten.json` проверяется
 *   --config <path>    другой `kaiten.json`
 *
 * Запуск: `pnpm run tasks:lint <dir>`.
 * Коды выхода: 0 — ошибок нет (предупреждения допустимы); 1 — есть ошибки;
 * 2 — не задан или не найден каталог.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadTasksRepoConfig, TASKS_REPO_CONFIG } from './config.js';
import { hostingProblem } from './core/hosting.js';
import { lintRepository } from './core/lint.js';
import { readTasksTree } from './tasks-files.js';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const valued = new Set(['--config']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1] ?? ''));
  const dir = positional[0] ?? process.env.TASKS_DIR;
  if (!dir || !existsSync(dir)) {
    console.error(dir ? `Нет каталога ${dir}` : 'Укажите каталог репозитория задач или TASKS_DIR');
    process.exit(2);
  }

  const configPath = argValue(argv, '--config') ?? join(dir, TASKS_REPO_CONFIG);
  let repos: string[] | undefined;
  if (existsSync(configPath)) {
    try {
      const { project } = loadTasksRepoConfig(configPath);
      const problem = hostingProblem(project.tasksRepo);
      if (problem) throw new Error(problem);
      repos = project.repos.map((r) => r.name);
    } catch (error) {
      console.log(`ошибка  ${TASKS_REPO_CONFIG}: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  const { files } = readTasksTree(dir);
  const result = lintRepository(files, repos);
  for (const file of result.byFile) {
    for (const issue of file.issues) console.log(`${issue.level === 'error' ? 'ошибка' : 'предупр.'}  ${file.path}: ${issue.message}`);
  }
  console.log(`\nФайлов: ${files.length}, ошибок: ${result.errors}, предупреждений: ${result.warnings}`);
  process.exit(result.errors > 0 ? 1 : 0);
}

main();
