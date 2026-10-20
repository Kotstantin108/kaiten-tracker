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
 *   --tasks <адрес>        хранилище задач проекта на этой машине (kaiten pull)
 *   --tasks <папка>        рабочая копия репозитория задач или дерево
 *                          конвертера — только сухой прогон
 *   --config <путь>        kaiten.json не из репозитория задач (пробные прогоны)
 *   --first-load           создать карточки и перенесённым задачам: открытым и
 *                          сделанным с месяца --closed-since (Q19: «done за три
 *                          месяца» — текущий и два предыдущих)
 *   --closed-since YYYY-MM
 *   --with-cancelled       в первую заливку — и отменённые за тот же срок
 *   --only <задача>        только одна задача (ключ, id или slug) или карточка
 *                          без задачи (её id) — пробный прогон на безвредной
 *                          карточке перед всеми
 *   --resend               отправить описание и чек-листы заново, даже если
 *                          карточка их уже получила: привести к файлу
 *                          карточки, доставленные прежними правилами; заодно
 *                          вложения — открытым задачам,
 *                          закрытым — только через --only. После этого файлы
 *                          задачи доставляет и фон
 *   --apply                выполнить; без него — план с подробностями по
 *                          каждой карточке (читаются только обновляемые)
 *
 * Вход в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN (`.env`), иначе `kaiten` в
 * `kaiten.settings.json`. Чтение доски идёт и в сухом прогоне.
 *
 * Коды выхода: 0 — ок; 1 — были ошибки Kaiten; 2 — ошибка аргументов.
 */

import { juniorFields, juniorSetting } from './config.js';
import { repoWebBase } from './core/kaiten-sync-plan.js';
import { buildIndex, resolveTask } from './core/tasks-index.js';
import { KaitenClient } from './kaiten-client.js';
import { attachmentRefs, blobReader, peopleByEmail, SETTINGS_PATH, today } from './kaiten-cli.js';
import { loadSettings } from './kaiten-context.js';
import { formatPlan, runKaitenSync } from './kaiten-sync.js';
import { KAITEN_LOCK, recordOp, syncStore, withLockAsync } from './store-write.js';
import { readTasksTree } from './tasks-files.js';
import { loadOwnerProject } from './owner-project.js';
import { isOutdated, publishSyncVersion, storedSyncVersion } from './self-update.js';
import { SYNC_VERSION } from './core/sync-version.js';
import { listEntries, readStoreTree } from './task-store.js';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

/** Месяц `n` месяцев назад — как месяц архива, по Москве. */
function monthsAgo(n: number, now = new Date()): string {
  const [year, month] = today(now).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  let owner;
  try {
    owner = loadOwnerProject(argv);
  } catch (error) {
    fail((error as Error).message);
  }
  const { project, config, people } = owner.loaded;
  const mapping = project.mapping;
  if (!mapping) fail(`У проекта ${project.title} нет доски в kaiten.json — сначала npm run setup -- --tasks <рабочая копия> --apply`);
  if (owner.source.kind !== 'store' && apply) fail('--apply пишет ключи карточек в задачи — только из хранилища задач: --tasks <адрес репозитория задач>');
  const store = owner.source.kind === 'store' ? owner.source.store : '';
  // Карточки этой копией переписались бы по-старому, а копии новее вернули бы их обратно.
  if (store && isOutdated(store)) fail('В задачах версия синхронизации новее, чем у этой копии kaiten-tracker: обновите её (git pull) и повторите.', 1);
  const entries = owner.source.kind === 'store' ? listEntries(store) : [];
  const tree = owner.source.kind === 'dir' ? readTasksTree(owner.source.dir) : owner.source.kind === 'store' ? readStoreTree(store, entries) : fail('--config без --tasks: укажите, откуда брать задачи');
  const index = buildIndex(tree.files, tree.logs);
  if (index.problems.length > 0) console.error(`Не читается задач: ${index.problems.length} — они не участвуют.`);

  const settings = loadSettings(SETTINGS_PATH);
  const domain = process.env.KAITEN_DOMAIN ?? settings.kaiten?.domain;
  const token = process.env.KAITEN_TOKEN ?? settings.kaiten?.token;
  if (!domain || !token) fail('Нет входа в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN в .env или kaiten в настройках');
  const client = new KaitenClient({ domain, token, minIntervalMs: 150 });

  const firstLoad = argv.includes('--first-load')
    ? { closedSince: argValue(argv, '--closed-since') ?? monthsAgo(2), withCancelled: argv.includes('--with-cancelled') }
    : undefined;
  const onlyRef = argValue(argv, '--only');
  let only: Set<string> | undefined;
  let onlyCards: Set<number> | undefined;
  if (onlyRef) {
    const found = resolveTask(index.tasks, onlyRef);
    // Номер карточки, у которой ещё нет задачи, — пробный перенос карточки в задачи.
    if ('error' in found && !/^\d+$/.test(onlyRef)) fail(found.error);
    only = new Set('error' in found ? [] : [found.task.fm.id]);
    onlyCards = new Set('error' in found ? [Number(onlyRef)] : []);
  }
  const input = {
    tasks: index.tasks,
    mapping,
    archiveInKaiten: project.kaiten.archiveInKaiten,
    junior: juniorFields(project),
    ignore: project.ignoreCards,
    repoWebBase: repoWebBase(project.tasksRepo?.url),
    defaultTeam: config.defaultTeam,
    boardId: mapping.boardId,
    firstLoad,
    resend: argv.includes('--resend'),
    // Файлы карточек — только из хранилища: в папке вложения не сверить с тем, что отправлено.
    attachments: owner.source.kind === 'store' ? attachmentRefs(entries) : undefined,
    readFile: owner.source.kind === 'store' ? blobReader(store) : undefined,
    only,
    onlyCards,
    people: peopleByEmail(people),
    date: today(),
  };
  // Запись — под тем же замком, что фон и pull: иначе две карточки одной задаче.
  let unpublished = false;
  const run = apply
    ? await withLockAsync(store, KAITEN_LOCK, () => {
        // Версия — в задачи раньше карточек: копии, которые её проверяют, остановятся до правок.
        unpublished = !publishSyncVersion(store, today()) && storedSyncVersion(store) < SYNC_VERSION;
        return runKaitenSync(client, input, 'apply');
      })
    : await runKaitenSync(client, input, 'details');

  const loadNote = firstLoad ? `, первая заливка (сделанные${firstLoad.withCancelled ? ' и отменённые' : ''} с ${firstLoad.closedSince})` : '';
  const resendNote = input.resend ? ', описание, чек-листы и файлы — заново' : '';
  console.log(`Проект ${project.title}, задач ${index.tasks.length}${loadNote}${resendNote}${onlyRef ? `, только ${onlyRef}` : ''}`);
  if (!project.tasksRepo?.url) console.log('Адреса репозитория задач нет — ссылки в описаниях будут просто текстом.');
  if (juniorSetting(project).state === 'needs-setup') console.log('Признак «Можно младшему» включён, а полей в Kaiten нет — они не пишутся: npm run setup.');
  for (const line of formatPlan(run)) console.log(line);
  if (unpublished) console.log('Версия синхронизации в задачи не записана: kaiten-tracker запущен не с выпущенной main. Копии kaiten на других машинах о новой версии не узнают.');
  if (!apply) {
    console.log('\nСухой прогон: в Kaiten ничего не записано (--apply — выполнить).');
    return;
  }

  for (const { op, what } of run.ops) {
    const r = recordOp(store, op, what, today());
    if ('error' in r) console.error(`Не записано в задачи: ${what} — ${r.error}`);
  }
  if (run.ops.length > 0) syncStore(store);
  console.log(`\nВыполнено действий: ${run.done} из ${run.plan.actions.length + run.adopt.candidates.length}; ключей и отметок в задачах: ${run.ops.length}.`);
  for (const e of run.errors) console.error(`Ошибка: ${e.what} — ${e.message}`);
  if (run.errors.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
