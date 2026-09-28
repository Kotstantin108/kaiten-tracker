/**
 * Скрипт владельца: синхронизация задач проекта с Kaiten — сухой прогон и
 * выполнение. Не команда `kaiten` для агента: массовые правки живого аккаунта
 * — по «да» владельца на показанный план (AGENTS.md, решение 16).
 *
 * Тот же планировщик, что у фоновой синхронизации: сухой прогон показывает
 * ровно то, что сделает включение `sync.kaiten`, — плюс первую заливку
 * (`--first-load`), которую фон не делает никогда.
 *
 * ФЛАГИ
 *   --project <key>        проект (обязателен, если их несколько)
 *   --config <path>        конфиг (по умолч. tracker.config.json)
 *   --tasks <dir>          читать задачи из папки (дерево конвертера) — только сухой прогон
 *   --first-load           создать карточки и перенесённым задачам: открытым и
 *                          закрытым с месяца --closed-since (по умолч. три месяца назад, Q19)
 *   --closed-since YYYY-MM
 *   --apply                выполнить; без него — только план
 *
 * Вход в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN (`.env`), иначе `kaiten` в
 * `kaiten.settings.json`. Чтение доски идёт и в сухом прогоне.
 *
 * Коды выхода: 0 — ок; 1 — были ошибки Kaiten; 2 — ошибка аргументов.
 */

import { existsSync } from 'node:fs';

import { loadProject } from './config.js';
import { repoWebBase } from './core/kaiten-sync-plan.js';
import { buildIndex } from './core/tasks-index.js';
import { KaitenClient } from './kaiten-client.js';
import { SETTINGS_PATH, today } from './kaiten-cli.js';
import { loadSettings } from './kaiten-context.js';
import { formatPlan, runKaitenSync } from './kaiten-sync.js';
import { recordOp, syncStore } from './store-write.js';
import { readTasksTree } from './tasks-files.js';
import { defaultStorePath, isStore, listEntries, readStoreTree } from './task-store.js';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function monthsAgo(n: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const { key, project, config } = loadProject(argValue(argv, '--config') ?? 'tracker.config.json', argValue(argv, '--project') ?? null);
  const mapping = project.mapping;
  if (!mapping) fail(`У проекта ${key} нет доски в конфиге — сначала npm run setup -- --project ${key} --apply`);

  const tasksDir = argValue(argv, '--tasks');
  if (tasksDir && apply) fail('--apply пишет ключи карточек в задачи — только из хранилища задач, без --tasks');
  const store = defaultStorePath(project.tasksRepo?.name ?? `${key}-tasks`);
  let tree;
  if (tasksDir) {
    if (!existsSync(tasksDir)) fail(`Нет каталога ${tasksDir}`);
    tree = readTasksTree(tasksDir);
  } else {
    if (!isStore(store)) fail(`Задач проекта ${key} на этой машине нет — kaiten pull или --tasks <dir>`);
    tree = readStoreTree(store, listEntries(store));
  }
  const index = buildIndex(tree.files, tree.logs);
  if (index.problems.length > 0) console.error(`Не читается задач: ${index.problems.length} — они не участвуют.`);

  const settings = loadSettings(SETTINGS_PATH);
  const domain = process.env.KAITEN_DOMAIN ?? settings.kaiten?.domain;
  const token = process.env.KAITEN_TOKEN ?? settings.kaiten?.token;
  if (!domain || !token) fail('Нет входа в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN в .env или kaiten в настройках');
  const client = new KaitenClient({ domain, token, minIntervalMs: 150 });

  const firstLoad = argv.includes('--first-load') ? { closedSince: argValue(argv, '--closed-since') ?? monthsAgo(3) } : undefined;
  const run = await runKaitenSync(
    client,
    {
      tasks: index.tasks,
      mapping,
      ignore: project.ignoreCards,
      repoWebBase: repoWebBase(project.tasksRepo?.url),
      defaultTeam: config.defaultTeam,
      boardId: mapping.boardId,
      firstLoad,
    },
    apply,
  );

  console.log(`Проект ${project.title}, задач ${index.tasks.length}${firstLoad ? `, первая заливка (закрытые с ${firstLoad.closedSince})` : ''}`);
  if (!project.tasksRepo?.url) console.log('Адреса репозитория задач нет — ссылки в описаниях будут просто текстом.');
  for (const line of formatPlan(run.plan)) console.log(line);
  if (!apply) {
    console.log('\nСухой прогон: в Kaiten ничего не записано (--apply — выполнить).');
    return;
  }

  for (const { op, what } of run.ops) {
    const r = recordOp(store, op, what, today());
    if ('error' in r) console.error(`Не записано в задачи: ${what} — ${r.error}`);
  }
  if (run.ops.length > 0) syncStore(store);
  console.log(`\nВыполнено действий: ${run.done} из ${run.plan.actions.length}; ключей и отметок в задачах: ${run.ops.length}.`);
  for (const e of run.errors) console.error(`Ошибка: ${e.what} — ${e.message}`);
  if (run.errors.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
