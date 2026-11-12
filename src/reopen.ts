/**
 * Скрипт владельца: увидеть задачи, отменённые одной пачкой, и вернуть их во
 * «Входящие» (`core/reopen.ts`).
 *
 *   npm run reopen -- --tasks <адрес> --log "<текст причины отмены>"            # список
 *   npm run reopen -- --tasks <адрес> --log "<текст>" --since 2026-11-12         # за день и позже
 *   npm run reopen -- --tasks <адрес> --only <задача>                            # одна задача
 *   npm run reopen -- --tasks <адрес> --log "<текст>" --apply --reason "<почему>"  # вернуть
 *
 * Без `--apply` — только список: ни в задачи, ни в Kaiten ничего не пишется.
 * `--apply` возвращает ровно то, что показал список с теми же флагами: сначала
 * карточку (во «Входящие», из архива Kaiten — тоже), затем статус в файле с
 * записью в журнал задачи. Приоритет, исполнителя и сроки не трогает.
 *
 * ФЛАГИ
 *   --tasks <адрес|папка>  репозиторий задач; --apply — только адрес
 *   --log <текст>          задачи, в причине отмены которых есть этот текст
 *   --since / --until      отменены не раньше / не позже дня YYYY-MM-DD
 *   --only <задача>        одна задача (ключ, id или slug); можно повторять
 *   --except <задача>      кроме этой; можно повторять
 *   --reason <почему>      запись в журнал задач при возврате
 *   --apply                вернуть
 *
 * Отменённые переносом карточки в Kaiten (записи об отмене в журнале нет) сюда
 * не попадают: такую задачу возвращают там же, переносом карточки.
 *
 * Коды выхода: 0 — ок; 1 — были ошибки; 2 — ошибка аргументов.
 */

import { findCancelled, reopenNote, type Cancellation } from './core/reopen.js';
import { buildIndex, refOf, resolveTask, type TaskRecord } from './core/tasks-index.js';
import { endWith } from './exit.js';
import { KaitenApiError, KaitenClient } from './kaiten-client.js';
import { currentPerson, SETTINGS_PATH, today } from './kaiten-cli.js';
import { loadSettings } from './kaiten-context.js';
import { apiErrorText } from './kaiten-sync.js';
import { loadOwnerProject } from './owner-project.js';
import { KAITEN_LOCK, recordOp, syncStore, withLockAsync } from './store-write.js';
import { listEntries, readStoreTree } from './task-store.js';
import { readTasksTree } from './tasks-files.js';

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

function argValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readTasks(owner: ReturnType<typeof loadOwnerProject>): TaskRecord[] {
  if (owner.source.kind === 'store') {
    const tree = readStoreTree(owner.source.store, listEntries(owner.source.store));
    return buildIndex(tree.files, tree.logs).tasks;
  }
  if (owner.source.kind === 'dir') {
    const tree = readTasksTree(owner.source.dir);
    return buildIndex(tree.files, tree.logs).tasks;
  }
  return fail('--config без --tasks: укажите, откуда брать задачи');
}

function oneLine(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function select(argv: readonly string[], tasks: readonly TaskRecord[]): Cancellation[] {
  const text = argValue(argv, '--log');
  const since = argValue(argv, '--since');
  const until = argValue(argv, '--until');
  for (const [flag, value] of [['--since', since], ['--until', until]] as const) if (value !== undefined && !DATE_RE.test(value)) fail(`${flag}: дата в формате YYYY-MM-DD`);
  const resolveAll = (flag: string): Set<string> =>
    new Set(
      argValues(argv, flag).map((ref) => {
        const found = resolveTask(tasks, ref);
        if ('error' in found) fail(`${flag} ${ref}: ${found.error}`);
        return found.task.fm.id;
      }),
    );
  const only = resolveAll('--only');
  const except = resolveAll('--except');
  if (!text && only.size === 0) fail('Какие задачи: --log "<текст причины отмены>" или --only <задача>');
  let picked = findCancelled(tasks, { text, since, until });
  if (only.size > 0) {
    for (const id of only) {
      if (picked.some((c) => c.task.fm.id === id)) continue;
      const task = tasks.find((t) => t.fm.id === id);
      const why = task?.fm.status !== 'cancelled' ? `она в статусе ${task?.fm.status ?? '?'}, а не отменена` : 'её отмена не записана в журнале с такой причиной и датой';
      fail(`--only: ${task ? refOf(task) : id} не подходит — ${why}`);
    }
    picked = picked.filter((c) => only.has(c.task.fm.id));
  }
  return picked.filter((c) => !except.has(c.task.fm.id));
}

function printList(title: string, picked: readonly Cancellation[]): void {
  console.log(`Проект ${title}: отменённых задач под отбор — ${picked.length}.`);
  if (picked.length === 0) return;
  const byType = new Map<string, number>();
  for (const c of picked) byType.set(c.task.fm.type, (byType.get(c.task.fm.type) ?? 0) + 1);
  console.log(`По типам: ${[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => `${type} — ${n}`).join(', ')}.\n`);
  const width = Math.max(...picked.map((c) => refOf(c.task).length));
  for (const c of picked) {
    const t = c.task;
    const who = [t.fm.created_via === 'agent' ? 'завёл агент' : t.fm.created_via === 'human' ? 'завёл человек' : 'перенесена', `создана ${t.fm.created}`, t.fm.epic ? `эпик ${t.fm.epic}` : ''].filter(Boolean).join(', ');
    console.log(`${refOf(t).padEnd(width)}  ${t.fm.type.padEnd(5)}  ${t.fm.repo ?? '—'}  ${t.fm.title}`);
    console.log(`${' '.repeat(width)}  ${who}; отменена ${c.stamp}${c.by ? ` · ${c.by}` : ''}: ${oneLine(c.reason)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('npm run reopen -- --tasks <адрес> --log "<текст причины отмены>" [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--only <задача>] [--except <задача>]');
    console.log('npm run reopen -- --tasks <адрес> … --apply --reason "<почему возвращаем>"');
    return;
  }
  const owner = loadOwnerProject(argv);
  const { project } = owner.loaded;
  const tasks = readTasks(owner);
  const picked = select(argv, tasks);
  printList(project.title, picked);

  if (!argv.includes('--apply')) {
    if (picked.length > 0) console.log('\nСухой прогон: ничего не записано. Вернуть эти задачи во «Входящие»: те же флаги и --apply --reason "<почему>".');
    return;
  }
  if (picked.length === 0) return;
  if (owner.source.kind !== 'store') fail('--apply пишет в задачи — только из хранилища задач: --tasks <адрес репозитория задач>');
  const store = owner.source.store;
  const reason = argValue(argv, '--reason')?.trim();
  if (!reason) fail('--reason "<почему>": запись в журнал задач — почему отмена снята');
  const column = project.mapping?.columns.inbox;
  const settings = loadSettings(SETTINGS_PATH);
  const domain = process.env.KAITEN_DOMAIN ?? settings.kaiten?.domain;
  const token = process.env.KAITEN_TOKEN ?? settings.kaiten?.token;
  const cardOf = (task: TaskRecord): number | null => (task.fm.tracker !== undefined && /^\d+$/.test(task.fm.tracker) && !project.ignoreCards.includes(Number(task.fm.tracker)) ? Number(task.fm.tracker) : null);
  const withCard = column !== undefined && picked.some((c) => cardOf(c.task) !== null);
  if (withCard && (!domain || !token)) fail('Нет входа в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN в .env или kaiten в настройках');
  const client = domain && token ? new KaitenClient({ domain, token, minIntervalMs: 150 }) : null;

  const date = today();
  // Кто возвращает — в запись журнала; не узнать (почты нет в реестре проекта) — запись без автора.
  let by: string | undefined;
  try {
    by = currentPerson(owner.loaded.people);
  } catch {
    by = undefined;
  }
  let applied = 0;
  let errors = 0;
  console.log('');
  // Под замком синхронизации: иначе фон вернул бы задаче статус карточки раньше, чем карточка переедет.
  await withLockAsync(store, KAITEN_LOCK, async () => {
    for (const { task } of picked) {
      const ref = refOf(task);
      const cardId = cardOf(task);
      let cardNote = '';
      if (cardId !== null && client && column !== undefined) {
        try {
          // Сначала карточка: статус в файле без неё вернулся бы при ближайшей сверке. `condition: 1` — из архива Kaiten.
          await client.updateCard(cardId, { column_id: column, condition: 1 });
        } catch (error) {
          // Карточки нет или она не видна — задача живёт только в файле: возвращаем файл и говорим об этом.
          const gone = error instanceof KaitenApiError && (error.status === 403 || error.status === 404);
          if (!gone) {
            console.error(`Не возвращена: ${ref} — Kaiten не перенёс карточку: ${apiErrorText(error)}`);
            errors += 1;
            continue;
          }
          cardNote = ' (карточка в Kaiten недоступна — только в задачах)';
        }
      }
      const moved = recordOp(store, { kind: 'mirror', items: [{ id: task.fm.id, status: 'inbox', settled: 'all', note: reopenNote(reason) }] }, `возврат во «Входящие»: ${ref}`, date, { by });
      if ('error' in moved) {
        console.error(`Не возвращена: ${ref} — ${moved.error}`);
        errors += 1;
        continue;
      }
      applied += 1;
      console.log(`${ref} — во «Входящих»${cardNote}`);
    }
  });
  if (applied > 0) syncStore(store);
  console.log(`\nВозвращено ${applied} из ${picked.length}.`);
  if (errors > 0) endWith(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  endWith(1);
});
