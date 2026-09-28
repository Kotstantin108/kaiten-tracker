/**
 * Заливка задач репозиториев в Kaiten.
 *
 * ЗАЧЕМ. Задачи живут файлами в нескольких репозиториях (Q17, Q22), и руками их
 * в трекер не перенести: в одном только `acme-app` их 455. Скрипт делает
 * первую заливку и попутно отвечает на часть вопросов пилота: как выглядит
 * импортированное тело, точен ли фильтр `external_id`, сколько стоит прогон по
 * лимитам.
 *
 * БЕЗОПАСНОСТЬ ПО УМОЛЧАНИЮ. Без `--apply` не делается ни одной записи. Без
 * токена скрипт работает офлайн: строит план только по локальным файлам и
 * честно говорит, что состояние аккаунта неизвестно. `--apply` без токена или
 * без заполненного маппинга — остановка.
 *
 * ИДЕМПОТЕНТНОСТЬ. Ключ — `external_id` = `<repo>:<YYYYMMDD>_<slug>`. Он
 * переживает и переезд задачи между папками (статус), и триаж (меняет тип и
 * приоритет). Повторный прогон находит карточку фильтром, сверяет хеш тела и
 * не трогает то, что не изменилось.
 *
 * ФЛАГИ
 *   --project <key>                        проект из конфига (обязателен, если их несколько)
 *   --overlay <path>                       «Суть» и команда задач, которых ещё нет в файлах (пилот)
 *   --scope pilot|active|active+done|all   что заливать (по умолч. active)
 *   --repo <name>[,<name>]                 какие репозитории из конфига
 *   --epic <slug>[,<slug>]                 для scope=pilot: эпики и их дерево
 *   --only <extId>[,<extId>]               точечный список, сильнее scope
 *   --done-since <YYYY-MM>                 граница done/ для scope=active+done
 *   --limit <N>                            не больше N карточек за прогон
 *   --config <path>                        конфиг (по умолч. tracker.config.json)
 *   --apply                                реально писать в Kaiten
 *   --link-epics                           планировать связи эпик → story
 *   --no-rewrite-links                     не переписывать ссылки в URL репозитория
 *   --report <path>                        куда писать JSON-отчёт
 *
 * ENV: `KAITEN_DOMAIN` (например `acme.kaiten.ru`) и `KAITEN_TOKEN`.
 * Запуск: `npm run import -- --scope pilot --epic reports`
 *
 * Коды выхода: 0 — ок; 2 — аргументы или нет токена при `--apply`;
 * 3 — маппинг не заполнен при `--apply`; 6 — ошибка выполнения.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { loadProject } from './config.js';
import { collectNumberedTasks } from './numbered-source.js';
import { KaitenClient, type Card } from './kaiten-client.js';
import {
  buildPlan,
  readFingerprint,
  type BoardMapping,
  type ChecklistPatch,
  type ExistingCard,
  type ImportPlan,
} from './plan.js';
import {
  collectTasks,
  normalizeRemoteUrl,
  selectScope,
  type RepoSource,
  type ScopeName,
  type SourceIssue,
  type TaskFile,
} from './task-source.js';

const OUT_DIR = 'tmp/import';
const DEFAULT_CONFIG = 'tracker.config.json';

interface Args {
  project: string | null;
  overlay: string | null;
  scope: ScopeName;
  repos: string[];
  epics: string[];
  only: string[];
  doneSince: string | null;
  limit: number | null;
  config: string;
  apply: boolean;
  linkEpics: boolean;
  rewriteLinks: boolean;
  report: string | null;
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    project: null,
    overlay: null,
    scope: 'active',
    repos: [],
    epics: [],
    only: [],
    doneSince: null,
    limit: null,
    config: DEFAULT_CONFIG,
    apply: false,
    linkEpics: false,
    rewriteLinks: true,
    report: null,
  };

  const scopes: readonly string[] = ['pilot', 'active', 'active+done', 'all'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => argv[++i] ?? '';
    const tail = (prefix: string): string => a.slice(prefix.length);
    if (a === '--apply') args.apply = true;
    else if (a === '--link-epics') args.linkEpics = true;
    else if (a === '--no-rewrite-links') args.rewriteLinks = false;
    else if (a === '--scope') args.scope = val() as ScopeName;
    else if (a.startsWith('--scope=')) args.scope = tail('--scope=') as ScopeName;
    else if (a === '--overlay') args.overlay = val();
    else if (a.startsWith('--overlay=')) args.overlay = tail('--overlay=');
    else if (a === '--project') args.project = val();
    else if (a.startsWith('--project=')) args.project = tail('--project=');
    else if (a === '--repo') args.repos.push(...val().split(','));
    else if (a.startsWith('--repo=')) args.repos.push(...tail('--repo=').split(','));
    else if (a === '--epic') args.epics.push(...val().split(','));
    else if (a.startsWith('--epic=')) args.epics.push(...tail('--epic=').split(','));
    else if (a === '--only') args.only.push(...val().split(','));
    else if (a.startsWith('--only=')) args.only.push(...tail('--only=').split(','));
    else if (a === '--done-since') args.doneSince = val();
    else if (a.startsWith('--done-since=')) args.doneSince = tail('--done-since=');
    else if (a === '--limit') args.limit = Number(val());
    else if (a.startsWith('--limit=')) args.limit = Number(tail('--limit='));
    else if (a === '--config') args.config = val();
    else if (a.startsWith('--config=')) args.config = tail('--config=');
    else if (a === '--report') args.report = val();
    else if (a.startsWith('--report=')) args.report = tail('--report=');
    else fail(`Неизвестный аргумент: ${a}`, 2);
  }

  if (!scopes.includes(args.scope)) fail(`--scope должен быть одним из: ${scopes.join(', ')}`, 2);
  const uniq = (list: string[]): string[] => [...new Set(list.map((e) => e.trim()).filter(Boolean))];
  args.repos = uniq(args.repos);
  args.epics = uniq(args.epics);
  args.only = uniq(args.only);
  if (args.scope === 'pilot' && args.epics.length === 0 && args.only.length === 0) {
    fail('--scope pilot требует --epic <slug> или --only <externalId>: пилотный срез выбирает человек, а не эвристика', 2);
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) fail('--limit должен быть > 0', 2);
  return args;
}

/**
 * URL репозитория: сначала явное поле конфига, затем реальный `origin`.
 * Угадывать владельца нельзя — ссылка уезжает в каждую карточку.
 */
function resolveRepoUrl(repoPath: string, configured?: string): string {
  if (configured) return configured;
  try {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf8' });
    return normalizeRemoteUrl(origin) ?? '';
  } catch {
    // Без git-ремоута постоянные ссылки построить не из чего: карточка уедет
    // с путём к папке вместо ссылки, и это лучше, чем выдуманный URL.
    return '';
  }
}

interface LoadedConfig {
  repos: RepoSource[];
  mapping: BoardMapping;
  /** Маппинг не заполнен: id колонок нули, значит писать нельзя. */
  unmapped: boolean;
}

function loadConfig(path: string, projectKey: string | null, wanted: string[]): LoadedConfig {
  let loaded;
  try {
    loaded = loadProject(path, projectKey);
  } catch (error) {
    fail((error as Error).message, 2);
  }
  const { project, config } = loaded;
  const base = dirname(resolve(path));

  // Задачи читаются только из репозиториев с рабочей копией; остальные в
  // конфиге — варианты поля «Репозиторий <Проект>».
  const readable = project.repos.filter((r) => r.path !== undefined);
  const selected = wanted.length > 0 ? readable.filter((r) => wanted.includes(r.name)) : readable;
  if (selected.length === 0) fail(`В проекте ${loaded.key} нет репозиториев с path${wanted.length ? ` из списка ${wanted.join(', ')}` : ''}`, 2);

  const repos: RepoSource[] = selected.map((repo) => {
    const repoPath = isAbsolute(repo.path as string) ? (repo.path as string) : resolve(base, repo.path as string);
    if (!existsSync(repoPath)) fail(`Репозиторий ${repo.name}: путь ${repoPath} не существует`, 2);
    return {
      name: repo.name,
      path: repoPath,
      url: resolveRepoUrl(repoPath, repo.url),
      branch: repo.branch,
      tasksDirName: repo.tasksDirName,
      layout: repo.layout,
    };
  });

  const k = project.mapping;
  if (!k) return { repos, mapping: { boardId: 0, columns: {} }, unmapped: true };
  const mapping: BoardMapping = {
    boardId: k.boardId,
    laneId: k.laneId,
    columns: k.columns as BoardMapping['columns'],
    types: k.types as BoardMapping['types'],
    priorityProperty: k.priorityProperty as BoardMapping['priorityProperty'],
    repoProperty: k.repoProperty,
    teamProperty: k.teamProperty,
    summaryProperty: k.summaryProperty,
    defaultTeam: config.defaultTeam,
  };
  const unmapped = k.boardId === 0 || Object.values(k.columns).every((id) => id === 0);
  return { repos, mapping, unmapped };
}

/**
 * Оверлей пилота: поля формата v2, которых в старых файлах нет («Суть»,
 * команда). Лежит в этом репозитории, потому что файлы задач чужих
 * репозиториев синхронизатор не правит (AGENTS.md). После конвертера v2
 * эти поля переедут во frontmatter, а оверлей удаляется.
 */
const OverlaySchema = z.record(
  z.string(),
  z.object({ summary: z.string().min(1).max(400).optional(), team: z.string().optional() }),
);

function applyOverlay(tasks: TaskFile[], path: string): { applied: number; missing: string[] } {
  const overlay = OverlaySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  let applied = 0;
  const missing: string[] = [];
  for (const task of tasks) {
    const extra = overlay[task.externalId];
    if (extra?.summary) task.summary = extra.summary;
    if (extra?.team) task.team = extra.team;
    if (extra) applied++;
    if (!task.summary) missing.push(task.externalId);
  }
  return { applied, missing };
}

function toExisting(card: Card): ExistingCard | null {
  if (card.external_id === null || card.external_id === undefined) return null;
  return {
    id: card.id,
    externalId: String(card.external_id),
    title: card.title,
    columnId: card.column_id,
    description: typeof card.description === 'string' ? card.description : undefined,
    parentIds: Array.isArray(card.parents_ids) ? card.parents_ids : card.parents_ids === null ? [] : undefined,
    childIds: Array.isArray(card.children_ids) ? card.children_ids : card.children_ids === null ? [] : undefined,
    checklists: Array.isArray(card.checklists)
      ? card.checklists.map((c) => ({ id: c.id, name: c.name ?? '', itemTexts: (c.items ?? []).map((i) => i.text ?? '') }))
      : undefined,
    properties: card.properties ?? undefined,
  };
}

/**
 * Состояние аккаунта: карточки доски по `external_id`. Если список не отдаёт
 * описание, оно дочитывается поштучно только для задач текущей выборки — иначе
 * каждый прогон переписывал бы все карточки подряд.
 */
async function loadExisting(
  client: KaitenClient,
  boardId: number,
  wanted: Set<string>,
): Promise<Map<string, ExistingCard>> {
  const cards = await client.listCards({ boardId });
  const map = new Map<string, ExistingCard>();
  for (const card of cards) {
    const existing = toExisting(card);
    if (existing) map.set(existing.externalId, existing);
  }
  for (const [externalId, existing] of map) {
    if (!wanted.has(externalId)) continue;
    // Описание и чек-листы список не отдаёт — дочитываем карточку поштучно.
    if (readFingerprint(existing.description) !== null && existing.checklists !== undefined) continue;
    const refreshed = toExisting(await client.getCard(existing.id));
    // Полная карточка без ключа `checklists` — чек-листов нет (живьём 23.09.2026
    // ключ отсутствует у карточки без чек-листов). В ответе списка это значит
    // «неизвестно», поэтому правило только здесь.
    if (refreshed) map.set(externalId, { ...refreshed, checklists: refreshed.checklists ?? [] });
  }
  return map;
}

function summarize(tasks: TaskFile[]): string {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    counts[`type:${t.meta.type}`] = (counts[`type:${t.meta.type}`] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

async function apply(client: KaitenClient, plan: ImportPlan, linkEpics: boolean): Promise<Record<string, number>> {
  const ids = new Map<string, number>();
  const result = { created: 0, updated: 0, linked: 0, linkFailed: 0, checklists: 0, checklistItems: 0, checklistFailed: 0 };

  /**
   * Чек-листы карточки: создаются по одному с пунктами. Отказ не валит
   * заливку — карточка уже есть, факт уходит в отчёт, повторный прогон
   * досоздаст недостающее по имени.
   */
  const addChecklists = async (externalId: string, cardId: number, lists: ChecklistPatch[]): Promise<void> => {
    for (const [index, list] of lists.entries()) {
      try {
        let checklistId = list.checklistId;
        if (checklistId !== undefined && list.rename) await client.renameChecklist(cardId, checklistId, list.name);
        if (checklistId === undefined) {
          checklistId = (await client.createChecklist(cardId, list.name, index + 1)).id;
          result.checklists++;
        }
        // Досоздаваемые пункты идут в конец: sort_order после имеющихся.
        const base = list.checklistId === undefined ? 0 : 1000;
        for (const [i, item] of list.items.entries()) {
          await client.addChecklistItem(checklistId, item, base + i + 1);
          result.checklistItems++;
        }
      } catch (error) {
        result.checklistFailed++;
        console.warn(`  ! чек-лист «${list.name}» у ${externalId}: ${(error as Error).message}`);
      }
    }
  };

  for (const action of plan.actions) {
    if (action.kind === 'create') {
      // Список карточек доски не обязан включать архив, а карточку могли увезти
      // на другую доску: без этой проверки повторный прогон создаст дубль.
      const stray = await client.findCardByExternalId(action.externalId);
      if (stray) {
        await client.updateCard(stray.id, action.payload);
        ids.set(action.externalId, stray.id);
        result.updated++;
        console.log(`  ~ ${action.externalId} → карточка ${stray.id} уже есть вне выборки доски, обновлена`);
        continue;
      }
      const card = await client.createCard(action.payload);
      ids.set(action.externalId, card.id);
      result.created++;
      console.log(`  + ${action.externalId} → карточка ${card.id}`);
      await addChecklists(action.externalId, card.id, action.checklists);
    } else if (action.kind === 'update') {
      await client.updateCard(action.cardId, action.payload);
      ids.set(action.externalId, action.cardId);
      result.updated++;
      console.log(`  ~ ${action.externalId} (${action.reasons.join(', ')})`);
    } else if (action.kind === 'unchanged') {
      ids.set(action.externalId, action.cardId);
    } else if (action.kind === 'checklists') {
      await addChecklists(action.externalId, action.cardId, action.checklists);
    }
  }

  if (linkEpics) {
    for (const action of plan.actions) {
      if (action.kind !== 'link') continue;
      const child = action.childCardId ?? ids.get(action.childExternalId);
      const parent = action.parentCardId ?? ids.get(action.parentExternalId);
      if (child === undefined || parent === undefined) continue;
      try {
        await client.addChild(parent, child);
        result.linked++;
      } catch (error) {
        // Эндпоинт связей в документации не раскрыт — падение здесь ожидаемо и
        // не должно валить заливку. Факт уходит в отчёт.
        result.linkFailed++;
        console.warn(`  ! связь ${action.parentExternalId} → ${action.childExternalId}: ${(error as Error).message}`);
      }
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const domain = process.env.KAITEN_DOMAIN ?? '';
  const token = process.env.KAITEN_TOKEN ?? '';
  const hasCreds = domain.length > 0 && token.length > 0;

  if (args.apply && !hasCreds) fail('--apply требует KAITEN_DOMAIN и KAITEN_TOKEN в окружении (.env)', 2);

  const { repos, mapping, unmapped } = loadConfig(args.config, args.project, args.repos);
  if (args.apply && unmapped) {
    fail('--apply требует заполненный блок kaiten в конфиге: сначала `npm run inspect`, затем id доски и колонок', 3);
  }

  const allTasks: TaskFile[] = [];
  const issues: SourceIssue[] = [];
  for (const repo of repos) {
    const scan = repo.layout === 'numbered' ? collectNumberedTasks(repo) : collectTasks(repo);
    allTasks.push(...scan.tasks);
    issues.push(...scan.issues);
  }

  let selected = selectScope(allTasks, {
    scope: args.scope,
    epics: args.epics,
    only: args.only,
    doneSince: args.doneSince,
  });
  const limited = args.limit !== null && selected.length > args.limit;
  if (limited) selected = selected.slice(0, args.limit ?? undefined);

  if (args.overlay) {
    const { applied, missing } = applyOverlay(selected, args.overlay);
    console.log(`Оверлей: полей добавлено у ${applied} задач; без «Сути»: ${missing.length}`);
    for (const id of missing.slice(0, 10)) console.log(`  ! без «Сути»: ${id}`);
  }

  // Пауза между запросами: живьём всплеск записей обрывался сетевой ошибкой.
  const client = hasCreds ? new KaitenClient({ domain, token, minIntervalMs: 150 }) : null;
  const existing =
    client && !unmapped
      ? await loadExisting(client, mapping.boardId, new Set(selected.map((t) => t.externalId)))
      : new Map<string, ExistingCard>();

  const plan = buildPlan({
    tasks: selected,
    existing,
    mapping,
    render: { rewriteLinks: args.rewriteLinks, summaryInDescription: !mapping.summaryProperty },
    linkEpics: args.linkEpics,
  });

  // Без маппинга колонок нет по определению — не засыпать вывод предупреждениями,
  // из-за которых не видно настоящих (родитель вне выборки и т.п.).
  const warnings = unmapped ? plan.warnings.filter((w) => !w.detail.startsWith('нет колонки')) : plan.warnings;
  const mode = args.apply ? 'APPLY' : unmapped ? 'DRY-RUN (маппинг не заполнен, состояние аккаунта неизвестно)' : 'DRY-RUN';

  console.log(`\nРежим: ${mode}`);
  console.log(`Репозитории: ${repos.map((r) => `${r.name}${r.url ? '' : ' (без origin)'}`).join(', ')}`);
  console.log(`Задач найдено: ${allTasks.length}, отобрано: ${selected.length}${limited ? ' (обрезано --limit)' : ''}`);
  console.log(
    `План: создать ${plan.stats.create}, обновить ${plan.stats.update}, без изменений ${plan.stats.unchanged}, связей ${plan.stats.link}, ` +
      `досоздать чек-листы у ${plan.stats.checklists}`,
  );
  const listed = plan.actions.flatMap((a) => (a.kind === 'create' || a.kind === 'checklists' ? a.checklists : []));
  if (listed.length > 0) {
    console.log(`Чек-листов в плане: ${listed.length}, пунктов: ${listed.reduce((n, c) => n + c.items.length, 0)}`);
  }
  console.log(`Срез: ${summarize(selected)}`);

  if (issues.length > 0) {
    const byKind = issues.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.problem]: (acc[i.problem] ?? 0) + 1 }), {});
    console.log(
      `Расхождения в репозиториях: ${Object.entries(byKind)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')} (подробности в отчёте)`,
    );
  }
  for (const warning of warnings.slice(0, 10)) console.log(`  ! ${warning.externalId}: ${warning.detail}`);
  if (warnings.length > 10) console.log(`  ! …ещё ${warnings.length - 10} предупреждений в отчёте`);

  let applied: Record<string, number> | null = null;
  let failure: string | null = null;
  try {
    if (args.apply && client) {
      console.log('\nПрименение:');
      applied = await apply(client, plan, args.linkEpics);
      console.log(
        `Итог: создано ${applied.created}, обновлено ${applied.updated}, связей ${applied.linked}, связей не вышло ${applied.linkFailed}, ` +
          `чек-листов ${applied.checklists} (пунктов ${applied.checklistItems}), чек-листов не вышло ${applied.checklistFailed}`,
      );
    } else {
      console.log('\nЗаписей не сделано. Для реальной заливки добавьте --apply.');
    }
  } catch (error) {
    // Отчёт нужен именно тогда, когда прогон упал на середине: без него
    // неизвестно, что уже создано в Kaiten.
    failure = error instanceof Error ? error.message : String(error);
  }

  const reportPath = args.report ?? join(OUT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode,
        repos: repos.map((r) => ({ name: r.name, path: r.path, url: r.url, branch: r.branch })),
        scope: { name: args.scope, epics: args.epics, only: args.only, doneSince: args.doneSince, limit: args.limit },
        counts: { found: allTasks.length, selected: selected.length, ...plan.stats },
        applied,
        failure,
        requests: client?.requestCount ?? 0,
        issues,
        warnings,
        actions: plan.actions.map((a) =>
          a.kind === 'link'
            ? { kind: a.kind, child: a.childExternalId, parent: a.parentExternalId }
            : a.kind === 'unchanged'
              ? { kind: a.kind, externalId: a.externalId, cardId: a.cardId }
              : a.kind === 'update'
                ? { kind: a.kind, externalId: a.externalId, cardId: a.cardId, reasons: a.reasons }
                : a.kind === 'checklists'
                  ? { kind: a.kind, externalId: a.externalId, cardId: a.cardId, checklists: a.checklists.map((c) => `${c.name} (${c.items.length})`) }
                  : {
                      kind: a.kind,
                      externalId: a.externalId,
                      title: a.title,
                      dir: a.task.dir,
                      checklists: a.checklists.map((c) => `${c.name} (${c.items.length})`),
                    },
        ),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Отчёт: ${reportPath}\n`);

  if (failure !== null) {
    console.error(`Прогон прерван: ${failure}`);
    process.exit(6);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(6);
});
