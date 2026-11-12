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

import type { AssessVerdict } from './core/schema.js';

const SelectMappingSchema = z.object({ id: z.number(), values: z.record(z.string(), z.number()) });

/** Блок id, который пишет `setup --apply` и читает импорт. */
export const MappingSchema = z.object({
  boardId: z.number(),
  /** Дорожка по умолчанию: эпики и задачи без своей дорожки продукта. */
  laneId: z.number().optional(),
  /** Дорожка продукта по имени репозитория (`repos[].lane`). */
  repoLanes: z.record(z.string(), z.number()).optional(),
  /** Дорожка «Архив»: закрытые больше месяца назад (`kaiten.archiveLane`). */
  archiveLaneId: z.number().optional(),
  columns: z.record(z.string(), z.number()),
  types: z.record(z.string(), z.number()).optional(),
  priorityProperty: SelectMappingSchema.optional(),
  /** Значения — по имени репозитория на GitHub, не по подписи. */
  repoProperty: z.object({ id: z.number(), values: z.record(z.string(), z.number()).optional() }).optional(),
  teamProperty: SelectMappingSchema.optional(),
  /** Текстовое поле «Суть» (решение 28.09.2026: поле вместо блока в описании). */
  summaryProperty: z.object({ id: z.number() }).optional(),
  /** Выбор «Можно младшему»: варианты `yes`/`no` (`kaiten.junior`). */
  juniorProperty: SelectMappingSchema.optional(),
  /** Строка «Младшему не хватает». */
  juniorMissingProperty: z.object({ id: z.number() }).optional(),
  /** Выбор «Оценка»: варианты `actual`/`done`/`obsolete` (`npm run assess`). */
  assessProperty: SelectMappingSchema.optional(),
  /** Выбор «Было / Стало»: варианты `yes`/`no` (`kaiten.visual`). */
  visualProperty: SelectMappingSchema.optional(),
  /** Выбор «Домен»: варианты — по имени домена (`domains`). */
  domainProperty: SelectMappingSchema.optional(),
});
export type ConfigMapping = z.infer<typeof MappingSchema>;

/**
 * Проверка проекта перед сдачей работы (`kaiten verify`, `core/review-gates.ts`):
 * команда оболочки, которую инструмент запускает в корне репозитория кода.
 * Имя попадает в журнал задачи и в сообщения.
 */
const CheckSchema = z
  .object({
    name: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u, 'имя проверки — буквы, цифры, пробел, точка, дефис, подчёркивание; до 40 знаков'),
    run: z.string().trim().min(1, 'пустая команда'),
    /** Предел времени проверки в минутах; дольше — «не прошла». */
    timeoutMin: z.number().positive().default(30),
  })
  .strict();
export type ReviewCheck = z.infer<typeof CheckSchema>;

const checkList = z.array(CheckSchema).superRefine((checks, ctx) => {
  const seen = new Set<string>();
  for (const [i, check] of checks.entries()) {
    if (seen.has(check.name)) ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `проверка «${check.name}» названа дважды` });
    seen.add(check.name);
  }
});
const docGlobs = z.array(z.string().trim().min(1));

/** Гейты сдачи одного репозитория кода: заданный ключ заменяет такой же ключ проекта целиком. */
const RepoReviewSchema = z.object({ checks: checkList.optional(), docs: docGlobs.optional() }).strict();

/**
 * Гейты сдачи работы (`docs/review-gates.md`). Нет блока — `kaiten review` и
 * `kaiten new` ведут себя как без него.
 */
const ReviewSchema = z
  .object({
    /** Проверки, без успешного прогона которых на текущем коммите `kaiten review` отказывает. */
    checks: checkList.default([]),
    /** Пути документации: в изменениях ветки задачи должен быть хотя бы один файл под ними. */
    docs: docGlobs.default([]),
    /** Раздел «Как проверить» обязателен в постановке story (`kaiten new`). */
    testPlan: z.boolean().default(false),
  })
  .strict();

/** Имя домена — как значение флага: латиница, цифры, дефис. */
export const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/;

export const RepoSchema = z.object({
  /** Имя репозитория кода на GitHub — оно же поле `repo` задачи. */
  name: z.string().min(1),
  /** Подпись варианта в Kaiten: `Acme-android`. */
  label: z.string().min(1),
  /** Путь к рабочей копии — только у репозиториев, из которых импорт читает задачи. */
  path: z.string().min(1).optional(),
  /** Дорожка продукта на доске: `Приложение`. Нет — карточки в дорожке по умолчанию. */
  lane: z.string().min(1).optional(),
  url: z.string().optional(),
  branch: z.string().default('main'),
  tasksDirName: z.string().optional(),
  /** `numbered` — школа globex (NNNN-slug.md), читается временным ридером пилота. */
  layout: z.enum(['folders', 'numbered']).default('folders'),
  /**
   * Общий репозиторий: агент оценки (`npm run assess`) видит его у каждой
   * задачи, а не только у задач с этим `repo`, — например, сценарии n8n.
   */
  shared: z.boolean().default(false),
  /** Свои проверки и пути документации этого репозитория вместо общих (`review` проекта). */
  review: RepoReviewSchema.optional(),
});
export type RepoConfig = z.infer<typeof RepoSchema>;

const ProjectObject = z.object({
  /** Название для людей: из него имя пространства и поля репозитория. */
  title: z.string().min(1),
  kaiten: z.object({
    space: z.string().min(1),
    board: z.string().min(1),
    /** Имя поля-выбора репозитория этого проекта. */
    repoField: z.string().min(1),
    /**
     * Родительское пространство («папка»): в нём пространство разработки и
     * пространства отделов. Нет — пространство разработки на верхнем уровне.
     */
    folder: z.string().min(1).optional(),
    /** Пространства отделов в папке — ключи шаблонов `DEPARTMENTS` (`setup-plan.ts`). */
    departments: z.array(z.string().min(1)).default([]),
    /** Дорожка закрытых больше месяца назад карточек: `Архив`. */
    archiveLane: z.string().min(1).optional(),
    /** Закрытые больше месяца назад карточки — в штатный архив Kaiten, а не на дорожку. */
    archiveInKaiten: z.boolean().default(false),
    /**
     * Признак «Можно младшему» (docs/junior-readiness.md): разделы продукта, БД
     * и n8n в каркасе задачи и два поля карточки. Нет блока — нет ничего.
     */
    junior: z.object({ maxAgeDays: z.number().int().positive().default(90) }).optional(),
    /**
     * «Было / Стало» (docs/visual-review.md): скриншоты до и после у задач на
     * ревью. `since` — с какого дня спрашивать: в отчёт владельца попадают
     * задачи без ответа, ушедшие на ревью или закрытые с этого дня.
     */
    visual: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'дата YYYY-MM-DD') }).optional(),
    /**
     * «Находки» (`kaiten found`, `core/found.ts`): колонка для дефектов, которые агент
     * заметил по ходу другой работы и которые подтвердило исследование. `model` — чем
     * исследовать. Нет блока — нет ни колонки, ни команды.
     */
    found: z.object({ model: z.string().min(1).default('claude-opus-5-5') }).optional(),
  }),
  repos: z.array(RepoSchema).min(1),
  /**
   * Репозиторий задач проекта. `name` — имя хранилища на машине
   * (`task-store.ts`), `url` нужен `kaiten pull` для первой загрузки; пока
   * репозиториев задач нет, его нет и в конфиге.
   */
  tasksRepo: z.object({ name: z.string().min(1), url: z.string().min(1).optional() }).optional(),
  /**
   * Карточки, которые синхронизация не трогает никогда: например, карточка без
   * задачи, которую не надо переносить, или задача, закрытая в Kaiten руками.
   */
  ignoreCards: z.array(z.number()).default([]),
  /** Поля, которые `setup` отключает и переименовывает (данные на карточках остаются). */
  retireFields: z.array(z.string()).default([]),
  /** Гейты сдачи работы: проверки, документация, «Как проверить». */
  review: ReviewSchema.optional(),
  /**
   * Домены задач: имя → правило ревью («человек читает изменения целиком»).
   * Инструмент домен только хранит и показывает; кто что читает — дело проекта.
   */
  domains: z
    .record(z.string(), z.string().trim().min(1, 'пустое правило ревью'))
    .superRefine((domains, ctx) => {
      for (const name of Object.keys(domains)) if (!DOMAIN_RE.test(name)) ctx.addIssue({ code: 'custom', path: [name], message: 'имя домена — латиница, цифры, дефис' });
    })
    .optional(),
  mapping: MappingSchema.optional(),
});

/**
 * Архив Kaiten вместо дорожки «Архив» — без дорожки: и без имени в
 * `kaiten.archiveLane`, и без её id в маппинге. Прежние версии `kaiten`
 * переносят на дорожку по id из маппинга — оставленный id делил бы закрытые
 * карточки между дорожкой и архивом.
 */
function archiveConflict(project: { kaiten: { archiveInKaiten: boolean; archiveLane?: string }; mapping?: { archiveLaneId?: number } }, ctx: z.RefinementCtx): void {
  if (!project.kaiten.archiveInKaiten) return;
  if (project.kaiten.archiveLane !== undefined) ctx.addIssue({ code: 'custom', path: ['kaiten', 'archiveLane'], message: 'вместе с archiveInKaiten дорожка «Архив» не нужна — уберите archiveLane' });
  if (project.mapping?.archiveLaneId !== undefined) ctx.addIssue({ code: 'custom', path: ['mapping', 'archiveLaneId'], message: 'вместе с archiveInKaiten уберите и mapping.archiveLaneId' });
}

export const ProjectSchema = ProjectObject.superRefine(archiveConflict);
export type ProjectConfig = z.infer<typeof ProjectSchema>;

/**
 * Признак «Можно младшему» в проекте. Включён, а id полей в маппинге нет —
 * задачи ведутся и разделы в каркасе есть, поля не пишутся до `setup`.
 */
export type JuniorSetting =
  | { state: 'off' }
  | { state: 'needs-setup'; maxAgeDays: number }
  | { state: 'on'; maxAgeDays: number; property: { id: number; yes: number; no: number }; missingPropertyId: number };

/** Признак, который можно писать в карточки: поля заведены. */
export type JuniorFields = Extract<JuniorSetting, { state: 'on' }>;

/** Поля признака для синхронизации; `undefined` — не пишем (выключен или ждёт setup). */
export function juniorFields(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): JuniorFields | undefined {
  const setting = juniorSetting(project);
  return setting.state === 'on' ? setting : undefined;
}

export function juniorSetting(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): JuniorSetting {
  const junior = project.kaiten.junior;
  if (!junior) return { state: 'off' };
  const select = project.mapping?.juniorProperty;
  const missing = project.mapping?.juniorMissingProperty;
  const yes = select?.values.yes;
  const no = select?.values.no;
  if (!select || !missing || yes === undefined || no === undefined) return { state: 'needs-setup', maxAgeDays: junior.maxAgeDays };
  return { state: 'on', maxAgeDays: junior.maxAgeDays, property: { id: select.id, yes, no }, missingPropertyId: missing.id };
}

/** Поле «Оценка»: id поля и его вариантов. */
export interface AssessField {
  id: number;
  values: Record<AssessVerdict, number>;
}

/** Поле «Оценка» проекта; `undefined` — признак выключен или поле не заведено (`setup`). */
export function assessField(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): AssessField | undefined {
  const select = project.mapping?.assessProperty;
  if (!project.kaiten.junior || !select) return undefined;
  const { actual, done, obsolete } = select.values;
  if (actual === undefined || done === undefined || obsolete === undefined) return undefined;
  return { id: select.id, values: { actual, done, obsolete } };
}

/**
 * «Было / Стало» в проекте. Включено, а id поля в маппинге нет — ничего не
 * спрашивается и не пишется до `setup`: ответ без поля в карточке некому показать.
 */
export type VisualSetting = { state: 'off' } | { state: 'needs-setup' } | { state: 'on'; since: string; property: { id: number; yes: number; no: number } };
export type VisualFields = Extract<VisualSetting, { state: 'on' }>;

export function visualSetting(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): VisualSetting {
  const visual = project.kaiten.visual;
  if (!visual) return { state: 'off' };
  const select = project.mapping?.visualProperty;
  const yes = select?.values.yes;
  const no = select?.values.no;
  if (!select || yes === undefined || no === undefined) return { state: 'needs-setup' };
  return { state: 'on', since: visual.since, property: { id: select.id, yes, no } };
}

/**
 * «Находки» в проекте. Включены, а колонки в маппинге нет — команда отказывает до
 * `setup`: подтверждённую находку некуда положить.
 */
export type FoundSetting = { state: 'off' } | { state: 'needs-setup' } | { state: 'on'; model: string };

export function foundSetting(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): FoundSetting {
  const found = project.kaiten.found;
  if (!found) return { state: 'off' };
  if (project.mapping?.columns.found === undefined) return { state: 'needs-setup' };
  return { state: 'on', model: found.model };
}

/** Гейты сдачи для репозитория кода: свои (`repos[].review`) поверх общих (`review`). Пустые списки — гейта нет. */
export interface ReviewGates {
  checks: readonly ReviewCheck[];
  docs: readonly string[];
  /** Основная ветка репозитория: от общего предка с ней считаются изменения ветки задачи. */
  mainBranch: string;
}

export function reviewGates(project: Pick<ProjectConfig, 'review' | 'repos'>, repoName: string): ReviewGates {
  const repo = project.repos.find((r) => r.name === repoName);
  return {
    checks: repo?.review?.checks ?? project.review?.checks ?? [],
    docs: repo?.review?.docs ?? project.review?.docs ?? [],
    mainBranch: repo?.branch ?? 'main',
  };
}

/** Обязателен ли раздел «Как проверить» в постановке story. */
export function testPlanRequired(project: Pick<ProjectConfig, 'review'>): boolean {
  return project.review?.testPlan === true;
}

/** Домены проекта: имя → правило ревью; `null` — проект домены не ведёт. */
export function domainsOf(project: Pick<ProjectConfig, 'domains'>): Readonly<Record<string, string>> | null {
  const domains = project.domains;
  return domains && Object.keys(domains).length > 0 ? domains : null;
}

/** Что не так с доменом задачи; `null` — годится (или домена нет). */
export function domainProblem(project: Pick<ProjectConfig, 'domains'>, domain: string | undefined): string | null {
  if (domain === undefined) return null;
  const domains = domainsOf(project);
  if (!domains) return 'в этом проекте домены задач не ведутся — уберите домен';
  if (!(domain in domains)) return `нет домена «${domain}». Можно: ${Object.keys(domains).join(', ')}`;
  return null;
}

/** Поле «Домен» для синхронизации; `undefined` — доменов нет или поле ещё не заведено (`setup`). */
export function domainField(project: Pick<ProjectConfig, 'domains' | 'mapping'>): { id: number; values: Record<string, number> } | undefined {
  return domainsOf(project) ? project.mapping?.domainProperty : undefined;
}

/** Поле «Было / Стало» для команд и синхронизации; `undefined` — выключено или ждёт setup. */
export function visualFields(project: Pick<ProjectConfig, 'kaiten' | 'mapping'>): VisualFields | undefined {
  const setting = visualSetting(project);
  return setting.state === 'on' ? setting : undefined;
}

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

export const TasksRepoConfigSchema = ProjectObject.extend({
  /** Ключ проекта: имя копии для чтения, метка в сообщениях скриптов. */
  project: z.string().regex(/^[a-z0-9-]+$/, 'ключ проекта — латиница, цифры, дефис'),
  teams: z.array(z.string().min(1)).default([]),
  defaultTeam: z.string().optional(),
  people: PeopleSchema.default({ people: {}, emails: {} }),
})
  .passthrough()
  .superRefine(archiveConflict);
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
