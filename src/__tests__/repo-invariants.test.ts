/**
 * Инварианты реальных репозиториев из `tracker.config.json`: они, а не
 * счётчики, защищают заливку. Счётчики задач меняются каждый день, поэтому их
 * здесь нет. Проверяется то, что обязано выполняться всегда: каждая папка
 * задачи разбирается, и ключ идемпотентности уникален. Нарушение любого из двух
 * означает, что повторный прогон создаст дубль карточки вместо обновления.
 *
 * Тест пропускается, если рабочих копий рядом нет (чистая машина, CI без
 * репозиториев). Это не «зелёный по умолчанию»: без файлов проверять нечего, а
 * пропуск виден в выводе.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigSchema } from '../config.js';
import { collectTasks, type RepoSource, type SourceScan } from '../task-source.js';

const CONFIG = resolve(import.meta.dirname, '..', '..', 'tracker.config.json');

function loadRepos(): RepoSource[] {
  if (!existsSync(CONFIG)) return [];
  // Конфиг — таблица проектов; задачи читаются только из репозиториев с path.
  const config = ConfigSchema.parse(JSON.parse(readFileSync(CONFIG, 'utf8')));
  const base = dirname(CONFIG);
  return Object.values(config.projects)
    .flatMap((project) => project.repos)
    .flatMap((repo) => (repo.path === undefined ? [] : [{ ...repo, path: repo.path }]))
    .map((repo) => ({
      name: repo.name,
      path: isAbsolute(repo.path) ? repo.path : resolve(base, repo.path),
      url: '',
      branch: repo.branch ?? 'main',
      tasksDirName: repo.tasksDirName,
    }))
    .filter((repo) => existsSync(resolve(repo.path, repo.tasksDirName ?? 'tasks')));
}

const repos = loadRepos();

describe.skipIf(repos.length === 0)('живые репозитории из tracker.config.json', () => {
  const scans: Array<{ repo: RepoSource; scan: SourceScan }> = repos.map((repo) => ({ repo, scan: collectTasks(repo) }));

  it('разбираются целиком: ни одного имени папки вне шаблона', () => {
    for (const { repo, scan } of scans) {
      const bad = scan.issues.filter((i) => i.problem === 'bad-folder-name');
      expect({ repo: repo.name, bad }).toEqual({ repo: repo.name, bad: [] });
      expect(scan.tasks.length).toBeGreaterThan(0);
    }
  });

  it('дают уникальный external_id на каждую задачу', () => {
    const seen = new Map<string, string[]>();
    for (const { scan } of scans) {
      for (const task of scan.tasks) {
        seen.set(task.externalId, [...(seen.get(task.externalId) ?? []), `${task.repoName}/${task.dir}`]);
      }
    }
    expect([...seen.entries()].filter(([, dirs]) => dirs.length > 1)).toEqual([]);
  });

  it('у каждой задачи есть заголовок', () => {
    for (const { scan } of scans) {
      expect(scan.tasks.filter((t) => t.title.trim().length === 0)).toEqual([]);
    }
  });
});
