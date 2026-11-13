/**
 * Проект для скриптов владельца (`setup`, `kaiten-sync`, `tasks:lint`,
 * `connect-repo`, конвертер): всё о проекте — в `kaiten.json` его
 * репозитория задач. Откуда его взять — флаг `--tasks`:
 *
 *   --tasks <папка>   рабочая копия репозитория задач: `kaiten.json` и задачи
 *                     читаются из неё, `setup` пишет id из Kaiten туда же
 *                     (закоммитить и отправить — руками);
 *   --tasks <адрес>   хранилище задач на этой машине (то же, что у `kaiten`;
 *                     загружается `kaiten pull` из подключённого репозитория);
 *                     перед чтением забирает свежие задачи, как `kaiten pull`.
 *
 * `--config <путь>` — `kaiten.json` откуда угодно (пробные прогоны, тесты).
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadTasksRepoConfig, projectFromTasksRepo, storeNameOf, TASKS_REPO_CONFIG, type LoadedProject, type People } from './config.js';
import { hostingProblem } from './core/hosting.js';
import { syncStore } from './store-write.js';
import { defaultStorePath, isStore, listEntries, readBlobs } from './task-store.js';

export type OwnerSource = { kind: 'dir'; dir: string; configPath: string } | { kind: 'store'; store: string; url: string } | { kind: 'file'; configPath: string };

export interface OwnerProject {
  loaded: LoadedProject & { people: People };
  source: OwnerSource;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * Репозиторий задач на своём сервере без названного хостинга — отказ: иначе
 * ссылки из карточек на задачи и журнал пропали бы молча, а заметили бы это
 * уже в Kaiten.
 */
function withKnownHosting(owner: OwnerProject): OwnerProject {
  const problem = hostingProblem(owner.loaded.project.tasksRepo);
  if (problem) throw new Error(problem);
  return owner;
}

/** Проект из `--tasks`/`--config`; ошибка — словами, что передать. */
export function loadOwnerProject(argv: readonly string[]): OwnerProject {
  return withKnownHosting(readOwnerProject(argv));
}

function readOwnerProject(argv: readonly string[]): OwnerProject {
  const config = argValue(argv, '--config');
  const tasks = argValue(argv, '--tasks');
  if (config && !tasks) return { loaded: loadTasksRepoConfig(resolve(config)), source: { kind: 'file', configPath: resolve(config) } };
  if (!tasks) throw new Error('Укажите --tasks <рабочая копия репозитория задач> или --tasks <адрес репозитория задач>');
  if (isDir(tasks)) {
    const dir = resolve(tasks);
    const configPath = config ? resolve(config) : join(dir, TASKS_REPO_CONFIG);
    return { loaded: loadTasksRepoConfig(configPath), source: { kind: 'dir', dir, configPath } };
  }
  const store = defaultStorePath(storeNameOf(tasks));
  if (!isStore(store)) throw new Error(`Задач по адресу ${tasks} на этой машине нет — kaiten pull из подключённого репозитория или --tasks <папка>`);
  // Хранилище — как на последнем `kaiten pull`: без свежих задач их карточки
  // выглядели бы чужими, а план — устаревшим.
  try {
    syncStore(store);
  } catch {
    throw new Error(`Свежие задачи по адресу ${tasks} не получены (нет связи или доступа к репозиторию) — повторите позже`);
  }
  if (config) return { loaded: loadTasksRepoConfig(resolve(config)), source: { kind: 'store', store, url: tasks } };
  const entry = listEntries(store).find((e) => e.path === TASKS_REPO_CONFIG);
  if (!entry) throw new Error(`В репозитории задач нет ${TASKS_REPO_CONFIG}`);
  const text = readBlobs(store, [entry.sha]).get(entry.sha)?.toString('utf8') ?? '';
  return { loaded: projectFromTasksRepo(text, tasks), source: { kind: 'store', store, url: tasks } };
}
