/**
 * Чтение репозитория задач с диска: файлы задач и их журналы. Общее для
 * линтера и CLI `kaiten` — какие файлы считаются задачами, решается здесь.
 *
 * Задача — любой `*.md` под `active/` и `archive/` на любой глубине, кроме
 * журналов `<slug>.log.md`: лишняя глубина сама станет ошибкой линтера.
 * Журнал лежит рядом с задачей (`convert-plan.ts`: `<dir>/<slug>.log.md`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { TaskFileText } from './core/lint.js';

export interface TasksTree {
  files: TaskFileText[];
  /** Журналы по пути файла задачи: `active/x.md` → текст `active/x.log.md`. */
  logs: Map<string, string>;
}

export function readTasksTree(root: string): TasksTree {
  const files: TaskFileText[] = [];
  const logs = new Map<string, string>();
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const childRel = `${rel}/${name}`;
      if (statSync(join(root, childRel)).isDirectory()) walk(childRel);
      else if (name.endsWith('.log.md')) logs.set(childRel.replace(/\.log\.md$/, '.md'), readFileSync(join(root, childRel), 'utf8'));
      else if (name.endsWith('.md')) files.push({ path: childRel, text: readFileSync(join(root, childRel), 'utf8') });
    }
  };
  for (const top of ['active', 'archive']) if (existsSync(join(root, top))) walk(top);
  return { files, logs };
}
