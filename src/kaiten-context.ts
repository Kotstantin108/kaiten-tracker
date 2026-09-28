/**
 * Откуда `kaiten` знает, с чем работать: файл проекта в репозитории кода и
 * настройки инструмента. Решения владельца 28.09.2026.
 *
 * ФАЙЛ ПРОЕКТА `.kaiten` — в корне репозитория кода (ищется вверх от текущей
 * папки, как `.editorconfig`). Две строки YAML:
 *
 *     project: acme
 *     repo: acme-app
 *
 * Нет файла — репозиторий не подключён к kaiten, и команды не работают:
 * ни флага `--project`, ни угадывания по `origin` или имени папки (в worktree
 * имя папки врёт). Файл кладёт владелец проекта на этапе подключения
 * проектов; команды его создания нет, чтобы агент не «подключал» репозиторий
 * сам.
 *
 * НАСТРОЙКИ `kaiten.settings.json` — рядом с `tracker.config.json` в
 * kaiten-tracker, у каждого разработчика свои (в `.gitignore`, пример —
 * `kaiten.settings.example.json`). В них:
 *   · `kaiten.domain` и `kaiten.token` — личный вход в Kaiten (для команд
 *     записи; скрипты `import`/`setup` пока читают `.env`);
 *   · `localCopy` — копия задач для чтения людьми. По умолчанию выключена;
 *     включённая — лежит в `<dir>/<проект>` и обновляется при каждом
 *     `kaiten pull`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PROJECT_FILE = '.kaiten';

const ProjectFileSchema = z
  .object({
    project: z.string().trim().min(1, 'пустое значение'),
    repo: z.string().trim().min(1, 'пустое значение'),
  })
  .strict();
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export type ProjectFileResult = { file: ProjectFile } | { missing: true } | { error: string };

/** Ближайший `.kaiten` вверх от `cwd`. */
export function findProjectFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, PROJECT_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseProjectFile(text: string): ProjectFileResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return { error: 'файл не разбирается: нужны две строки «project: …» и «repo: …»' };
  }
  const parsed = ProjectFileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'файл'}: ${i.input === undefined ? 'обязательное поле' : i.message}`).join('; ') };
  }
  return { file: parsed.data };
}

export function readProjectFile(cwd: string): ProjectFileResult {
  const path = findProjectFile(cwd);
  if (!path) return { missing: true };
  return parseProjectFile(readFileSync(path, 'utf8'));
}

// ── настройки инструмента ────────────────────────────────────────────────

const SettingsSchema = z
  .object({
    /**
     * Вход в Kaiten личным токеном того, кто работает (решение 4). Нужен
     * командам записи; чтение идёт без сети. Токен не печатается никогда —
     * ни в выводе, ни в ошибках разбора настроек.
     */
    kaiten: z
      .object({
        domain: z.string().trim().min(1, 'пустое значение'),
        token: z.string().trim().min(1, 'пустое значение'),
      })
      .strict()
      .optional(),
    localCopy: z
      .object({
        enabled: z.boolean().default(false),
        /** Папка для копий; копия проекта — `<dir>/<проект>`. */
        dir: z.string().trim().min(1).optional(),
      })
      .strict()
      .refine((c) => !c.enabled || c.dir !== undefined, { message: 'включена, но не задана папка dir', path: ['dir'] })
      .default({ enabled: false }),
  })
  .strict();
export type KaitenSettings = z.infer<typeof SettingsSchema>;

export class SettingsError extends Error {}

/** Нет файла — всё по умолчанию: копии нет. */
export function loadSettings(path: string): KaitenSettings {
  if (!existsSync(path)) return SettingsSchema.parse({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SettingsError('настройки kaiten не разбираются: это должен быть JSON');
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    // Только путь поля и правило — значение (там может быть токен) не выводим.
    throw new SettingsError(`настройки kaiten: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'файл'}: ${ruIssue(i)}`).join('; ')}`);
  }
  return parsed.data;
}

function ruIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') return `незнакомые ключи ${issue.keys.join(', ')}`;
  if (issue.code === 'invalid_type') return issue.input === undefined ? 'обязательное поле' : `нужен тип ${issue.expected}`;
  return issue.message;
}

/** Папка копии проекта или `null`, если копия выключена. */
export function localCopyDir(settings: KaitenSettings, project: string): string | null {
  const { enabled, dir } = settings.localCopy;
  return enabled && dir ? join(resolve(dir), project) : null;
}
