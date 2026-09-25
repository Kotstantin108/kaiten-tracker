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
export function loadProject(path: string, wanted: string | null): LoadedProject {
  if (!existsSync(path)) throw new Error(`Не найден конфиг ${path}`);
  const config = ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const keys = Object.keys(config.projects);
  const key = wanted ?? (keys.length === 1 ? keys[0] : null);
  if (!key) throw new Error(`В конфиге несколько проектов (${keys.join(', ')}) — укажите --project`);
  const project = config.projects[key];
  if (!project) throw new Error(`Проекта «${key}» нет в конфиге (есть: ${keys.join(', ')})`);
  return { key, project, config };
}

/** Записать маппинг проекта, не трогая остальной конфиг. */
export function saveMapping(path: string, key: string, mapping: ConfigMapping): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { projects: Record<string, Record<string, unknown>> };
  raw.projects[key].mapping = mapping;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}
