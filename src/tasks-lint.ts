/**
 * Линтер репозитория задач v2: проверяет все файлы `active/*.md` и
 * `archive/YYYY-MM/*.md` (журналы `*.log.md` — нет). Только чтение.
 *
 * ФЛАГИ
 *   <dir>              корень репозитория задач (по умолч. `TASKS_DIR`)
 *   --project <key>    сверить `repo` с репозиториями проекта из конфига
 *   --config <path>    конфиг (по умолч. tracker.config.json)
 *
 * Запуск: `npm run tasks:lint -- <dir> --project acme`.
 * Коды выхода: 0 — ошибок нет (предупреждения допустимы); 1 — есть ошибки;
 * 2 — не задан или не найден каталог.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadProject } from './config.js';
import { lintRepository, type TaskFileText } from './core/lint.js';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Файлы задач: всё `*.md` кроме журналов, на любой глубине под active/ и archive/ — лишняя глубина сама станет ошибкой линтера. */
function collect(root: string): TaskFileText[] {
  const out: TaskFileText[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = `${rel}/${name}`;
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (name.endsWith('.md') && !name.endsWith('.log.md')) out.push({ path: childRel, text: readFileSync(join(root, childRel), 'utf8') });
    }
  };
  for (const top of ['active', 'archive']) if (existsSync(join(root, top))) walk(top);
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const valued = new Set(['--project', '--config']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1] ?? ''));
  const dir = positional[0] ?? process.env.TASKS_DIR;
  if (!dir || !existsSync(dir)) {
    console.error(dir ? `Нет каталога ${dir}` : 'Укажите каталог репозитория задач или TASKS_DIR');
    process.exit(2);
  }

  const projectKey = argValue(argv, '--project');
  const repos = projectKey
    ? loadProject(argValue(argv, '--config') ?? 'tracker.config.json', projectKey).project.repos.map((r) => r.name)
    : undefined;

  const files = collect(dir);
  const result = lintRepository(files, repos);
  for (const file of result.byFile) {
    for (const issue of file.issues) console.log(`${issue.level === 'error' ? 'ошибка' : 'предупр.'}  ${file.path}: ${issue.message}`);
  }
  console.log(`\nФайлов: ${files.length}, ошибок: ${result.errors}, предупреждений: ${result.warnings}`);
  process.exit(result.errors > 0 ? 1 : 0);
}

main();
