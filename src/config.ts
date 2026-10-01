/**
 * Конфиг синхронизатора: таблица проектов.
 *
 * Проект = отдельный репозиторий задач = доска Kaiten = команда на GitHub
 * (решение 25.09.2026: задачи Acme и globex в разных репозиториях, чтобы
 * разделять разработчиков — git не умеет прав на папку). Подпродукты проекта
 * (app, landing, android…) — не папки, а варианты поля «Репозиторий <Проект>»
 * с подписью вида `Acme-android`.
 *
 * Общие на компанию поля — «Приоритет» и «Команда»; поле репозитория своё у
 * каждого проекта, чтобы одна команда не видела репозитории другой.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

const SelectMappingSchema = z.object({ id: z.number(), values: z.record(z.string(), z.number()) });

/** Блок id, который пишет `setup --apply` и читает импорт. */
export const MappingSchema = z.object({
  boardId: z.number(),
  laneId: z.number().optional(),
  columns: z.record(z.string(), z.number()),
  types: z.record(z.string(), z.number()).optional(),
  priorityProperty: SelectMappingSchema.optional(),
  /** Значения — по имени репозитория на GitHub, не по подписи. */
  repoProperty: z.object({ id: z.number(), values: z.record(z.string(), z.number()).optional() }).optional(),
  teamProperty: SelectMappingSchema.optional(),
  /** Текстовое поле «Суть» (решение 28.09.2026: поле вместо блока в описании). */
  summaryProperty: z.object({ id: z.number() }).optional(),
});
export type ConfigMapping = z.infer<typeof MappingSchema>;

export const RepoSchema = z.object({
  /** Имя репозитория кода на GitHub — оно же поле `repo` задачи. */
  name: z.string().min(1),
  /** Подпись варианта в Kaiten: `Acme-android`. */
  label: z.string().min(1),
  /** Путь к рабочей копии — только у репозиториев, из которых импорт читает задачи. */
  path: z.string().min(1).optional(),
  url: z.string().optional(),
  branch: z.string().default('main'),
  tasksDirName: z.string().optional(),
  /** `numbered` — школа globex (NNNN-slug.md), читается временным ридером пилота. */
  layout: z.enum(['folders', 'numbered']).default('folders'),
});
export type RepoConfig = z.infer<typeof RepoSchema>;

export const ProjectSchema = z.object({
  /** Название для людей: из него имя пространства и поля репозитория. */
  title: z.string().min(1),
  kaiten: z.object({
    space: z.string().min(1),
    board: z.string().min(1),
    /** Имя поля-выбора репозитория этого проекта. */
    repoField: z.string().min(1),
  }),
  repos: z.array(RepoSchema).min(1),
  /**
   * Репозиторий задач проекта. `name` — имя хранилища на машине
   * (`task-store.ts`), `url` нужен `kaiten pull` для первой загрузки; пока
   * репозиториев задач нет, его нет и в конфиге.
   */
  tasksRepo: z.object({ name: z.string().min(1), url: z.string().min(1).optional() }).optional(),
  /**
   * Карточки, которые синхронизация не трогает никогда: владелец сказал не
   * трогать (28.09: «Что-то» 10000003 без external_id и story export-csv
   * 10000002, перенесённая в «Сделано» руками).
   */
  ignoreCards: z.array(z.number()).default([]),
  /** Поля, которые `setup` отключает и переименовывает (данные на карточках остаются). */
  retireFields: z.array(z.string()).default([]),
  mapping: MappingSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectSchema>;

export const ConfigSchema = z
  .object({
    teams: z.array(z.string().min(1)).default([]),
    /** Команда для задач из репозиториев кода: это задачи разработки. */
    defaultTeam: z.string().optional(),
    projects: z.record(z.string(), ProjectSchema),
  })
  .passthrough();
export type TrackerConfig = z.infer<typeof ConfigSchema>;

export interface LoadedProject {
  key: string;
  project: ProjectConfig;
  config: TrackerConfig;
}

/**
 * Проект из конфига. Без `--project` — единственный проект; если их
 * несколько, выбрать должен человек: писать не в ту доску нельзя.
 */
export function loadConfig(path: string): TrackerConfig {
  if (!existsSync(path)) throw new Error(`Не найден конфиг ${path}`);
  return ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadProject(path: string, wanted: string | null): LoadedProject {
  const config = loadConfig(path);
  const keys = Object.keys(config.projects);
  const key = wanted ?? (keys.length === 1 ? keys[0] : null);
  if (!key) throw new Error(`В конфиге несколько проектов (${keys.join(', ')}) — укажите --project`);
  const project = config.projects[key];
  if (!project) throw new Error(`Проекта «${key}» нет в конфиге (есть: ${keys.join(', ')})`);
  return { key, project, config };
}

/** Записать маппинг проекта, не трогая остальной конфиг (файл любого из двух видов). */
export function saveMapping(path: string, key: string, mapping: ConfigMapping): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { projects?: Record<string, Record<string, unknown>> };
  if (raw.projects) raw.projects[key].mapping = mapping;
  else raw.mapping = mapping;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

// ── конфиг в репозитории задач ───────────────────────────────────────────
//
// Инструмент не знает ни одного проекта: всё о проекте лежит в корне его
// репозитория задач, в `kaiten.json` (решение владельца 01.10.2026 — сам
// kaiten-tracker публичный). Внутри кода проект по-прежнему виден как
// `LoadedProject`: файл переводится в таблицу из одного проекта.

/** Имя файла конфига в корне репозитория задач. */
export const TASKS_REPO_CONFIG = 'kaiten.json';

/** Реестр людей: ключ человека (как в `created_by`) и почты его коммитов. */
export const PeopleSchema = z.object({
  people: z.record(z.string(), z.object({ name: z.string().optional() }).passthrough()).default({}),
  emails: z.record(z.string(), z.string()).default({}),
});
export type People = z.infer<typeof PeopleSchema>;

export const TasksRepoConfigSchema = ProjectSchema.extend({
  /** Ключ проекта: имя копии для чтения, метка в сообщениях скриптов. */
  project: z.string().regex(/^[a-z0-9-]+$/, 'ключ проекта — латиница, цифры, дефис'),
  teams: z.array(z.string().min(1)).default([]),
  defaultTeam: z.string().optional(),
  people: PeopleSchema.default({ people: {}, emails: {} }),
}).passthrough();
export type TasksRepoConfig = z.infer<typeof TasksRepoConfigSchema>;

/** Конфиг из `kaiten.json` → проект; `url` — адрес репозитория задач, если его знает вызывающий (`.kaiten`). */
export function projectFromTasksRepo(text: string, url?: string): LoadedProject & { people: People } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${TASKS_REPO_CONFIG} не разбирается как JSON`);
  }
  const parsed = TasksRepoConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${TASKS_REPO_CONFIG}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`).join('; ')}`);
  const { project: key, teams, defaultTeam, people, ...rest } = parsed.data;
  const tasksUrl = rest.tasksRepo?.url ?? url;
  const project = ProjectSchema.parse({ ...rest, tasksRepo: { name: rest.tasksRepo?.name ?? storeNameOf(tasksUrl ?? `${key}-tasks`), ...(tasksUrl ? { url: tasksUrl } : {}) } });
  const config = ConfigSchema.parse({ teams, defaultTeam, projects: { [key]: project } });
  return { key, project, config, people };
}

/** Конфиг из файла `kaiten.json` (рабочая копия репозитория задач или `--config`). */
export function loadTasksRepoConfig(path: string): LoadedProject & { people: People } {
  if (!existsSync(path)) throw new Error(`Не найден ${path}`);
  return projectFromTasksRepo(readFileSync(path, 'utf8'));
}

/** Имя хранилища на машине — по адресу репозитория задач: `…/acme-tasks.git` → `acme-tasks`. */
export function storeNameOf(url: string): string {
  const base = url.replace(/[\\/]+$/, '').split(/[\\/:]/).at(-1) ?? url;
  return base.replace(/\.git$/, '') || 'tasks';
}
