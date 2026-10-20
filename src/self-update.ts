/**
 * Самообновление `kaiten`. Повод — только версия синхронизации: в репозитории
 * задач записана версия новее своей (`core/sync-version.ts`), значит, эта
 * копия переписала бы карточки по-старому. Тогда `kaiten` подтягивает
 * основную ветку в своей папке и перезапускает ту же команду уже новым кодом.
 *
 * Перезапуск — только там, где повтор безвреден: до разбора команды (ничего
 * не прочитано из stdin и не записано) и в `pull`. Не обновился — команда
 * работает как раньше, а в карточки не пишет: шаг Kaiten пропускается, пока
 * `kaiten` не обновят.
 *
 * Обновляется только чистая папка на основной ветке и только перемоткой. Новой
 * версии нужны другие зависимости — сами не ставим: на Windows их держит
 * запущенный процесс, и папка осталась бы наполовину обновлённой.
 *
 * Свою версию синхронизация пишет в задачи только из выпущенного кода
 * (`canPublishVersion`): версия из невлитой ветки остановила бы синхронизацию
 * у всех, кому обновляться не на что.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSyncVersion, SYNC_VERSION, SYNC_VERSION_FILE } from './core/sync-version.js';
import { recordOp, syncStore, withLock } from './store-write.js';
import { git, gitText, StoreError } from './task-store.js';

/** Ветка, с которой обновляется `kaiten`. */
const TOOL_BRANCH = 'main';
const UPDATE_LOCK = 'kaiten-update.lock';
/** Метка перезапуска: обновлённый процесс второй раз не обновляется. */
const UPDATED_ENV = 'KAITEN_UPDATED';

/** Папка инструмента; `KAITEN_TOOL_DIR` — для тестов, пустая — папки нет (не обновляться, версию не писать). */
export function toolDir(): string | null {
  const override = process.env.KAITEN_TOOL_DIR;
  if (override !== undefined) return override || null;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Версия синхронизации в задачах на этой машине (с неотправленными изменениями). */
export function storedSyncVersion(store: string): number {
  if (!existsSync(store)) return 0;
  try {
    return parseSyncVersion(gitText(store, ['cat-file', 'blob', `HEAD:${SYNC_VERSION_FILE}`]));
  } catch {
    return 0;
  }
}

export function isOutdated(store: string): boolean {
  return storedSyncVersion(store) > SYNC_VERSION;
}

/** Что сказать, пока `kaiten` устарел; причина — почему не обновился сам. */
export function outdatedMessage(reason: string): string {
  return `kaiten на этой машине устарел и сам не обновился: ${reason}. Пока его не обновят, карточки Kaiten эта машина не обновляет — задачи при этом записываются и отправляются. Обновить: git pull в папке kaiten.`;
}

/** Причина в «Kaiten не обновлён» у пропущенного шага Kaiten. */
export const OUTDATED_NOTE = 'kaiten на этой машине устарел и в карточки не пишет — обновите: git pull в папке kaiten';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

function tryGit(dir: string, args: string[]): string | null {
  try {
    return git(dir, args, undefined, ENV).toString('utf8').trim();
  } catch (error) {
    if (error instanceof StoreError) return null;
    throw error;
  }
}

function isAncestor(dir: string, ancestor: string, of: string): boolean {
  try {
    git(dir, ['merge-base', '--is-ancestor', ancestor, of]);
    return true;
  } catch {
    return false;
  }
}

/** Папка — чистая копия основной ветки (свои коммиты и правки не трогаем). Причина — если нет. */
function folderProblem(dir: string): string | null {
  if (!existsSync(join(dir, '.git'))) return 'kaiten установлен не из git';
  if (tryGit(dir, ['symbolic-ref', '--short', 'HEAD']) !== TOOL_BRANCH) return `папка kaiten не на ветке ${TOOL_BRANCH}`;
  const status = tryGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (status === null || status !== '') return 'в папке kaiten есть свои правки';
  return null;
}

export type UpdateResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Перемотать папку `kaiten` на свежую основную ветку. `changed: false` — она
 * уже свежая (возможно, её только что обновил соседний процесс): перезапуск
 * всё равно нужен — в памяти код старый.
 */
export function updateTool(dir: string | null = toolDir()): UpdateResult {
  if (!dir) return { ok: false, reason: 'папка kaiten неизвестна' };
  const problem = folderProblem(dir);
  if (problem) return { ok: false, reason: problem };
  try {
    // Несколько агентов на машине упрутся в устаревший kaiten разом: обновляет один.
    return withLock(dir, UPDATE_LOCK, (): UpdateResult => {
      if (tryGit(dir, ['fetch', '--quiet', 'origin', TOOL_BRANCH]) === null) return { ok: false, reason: 'не удалось получить новую версию (нет связи или доступа к репозиторию kaiten)' };
      const upstream = `origin/${TOOL_BRANCH}`;
      const head = tryGit(dir, ['rev-parse', 'HEAD']);
      const target = tryGit(dir, ['rev-parse', upstream]);
      if (!head || !target) return { ok: false, reason: 'папка kaiten не похожа на копию его репозитория' };
      if (head === target) return { ok: true, changed: false };
      if (!isAncestor(dir, head, target)) return { ok: false, reason: 'в папке kaiten свои коммиты' };
      const deps = tryGit(dir, ['diff', '--name-only', head, target, '--', 'package.json', 'package-lock.json']);
      if (deps === null || deps !== '') return { ok: false, reason: 'новой версии нужны другие зависимости — git pull и npm install в папке kaiten' };
      if (tryGit(dir, ['merge', '--ff-only', '--quiet', upstream]) === null) return { ok: false, reason: 'git не смог обновить папку kaiten' };
      return { ok: true, changed: true };
    });
  } catch (error) {
    if (error instanceof StoreError) return { ok: false, reason: 'папку kaiten сейчас обновляет другой процесс или она недоступна' };
    throw error;
  }
}

/** Запустить ту же команду заново (уже обновлённым кодом) и выйти с её кодом. */
export function rerun(): never {
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, [UPDATED_ENV]: '1' },
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

export type Freshness = { state: 'current' } | { state: 'updated' } | { state: 'outdated'; reason: string };

/**
 * Свежий ли `kaiten` для задач в `store`; устарел — попробовать обновиться.
 * `updated` — папка обновлена, вызывающий перезапускает команду (`rerun`).
 */
export function ensureFresh(store: string): Freshness {
  if (!isOutdated(store)) return { state: 'current' };
  if (process.env[UPDATED_ENV]) return { state: 'outdated', reason: 'в задачах версия синхронизации новее, чем в последней версии kaiten, — сообщите владельцу проекта' };
  const result = updateTool();
  return result.ok ? { state: 'updated' } : { state: 'outdated', reason: result.reason };
}

/**
 * Можно ли записать свою версию синхронизации в задачи: код выпущен — чистая
 * основная ветка, которая уже есть в общей (`origin/main`).
 */
export function canPublishVersion(dir: string | null = toolDir()): boolean {
  if (!dir || folderProblem(dir)) return false;
  return isAncestor(dir, 'HEAD', `origin/${TOOL_BRANCH}`);
}

/**
 * Записать свою версию синхронизации в задачи и сразу отправить — до первой
 * правки карточек, чтобы старые копии остановились раньше, чем карточки
 * поменяются. Вызывать под замком шага Kaiten. `true` — записано.
 */
export function publishSyncVersion(store: string, date: string): boolean {
  if (storedSyncVersion(store) >= SYNC_VERSION || !canPublishVersion()) return false;
  const recorded = recordOp(store, { kind: 'sync-version', version: SYNC_VERSION }, `версия синхронизации ${SYNC_VERSION}`, date);
  if ('error' in recorded) return false;
  try {
    syncStore(store);
  } catch (error) {
    // Не отправилось — уйдёт со следующей отправкой; карточкам это не мешает.
    if (!(error instanceof StoreError)) throw error;
  }
  return true;
}

/** Сколько коммитов основной ветки ещё нет у этой копии; `null` — не узнать (нет связи, не git). Для `kaiten doctor`. */
export function updatesAvailable(dir: string | null = toolDir()): number | null {
  if (!dir || !existsSync(join(dir, '.git'))) return null;
  if (tryGit(dir, ['fetch', '--quiet', 'origin', TOOL_BRANCH]) === null) return null;
  const count = tryGit(dir, ['rev-list', '--count', `HEAD..origin/${TOOL_BRANCH}`]);
  return count === null ? null : Number(count);
}
