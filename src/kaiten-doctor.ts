/**
 * `kaiten doctor` — проверка установки: всё ли на машине и в репозитории
 * готово к работе с задачами, и что исправить, если нет.
 *
 * Зачем. Установка — это три слоя (машина, репозиторий кода, проект), и без
 * этой команды человек узнаёт о пропущенном шаге по отказу первой попавшейся
 * команды, а агент — по отказу посреди работы (испытание 30.09.2026: «не
 * хватило команды вроде kaiten status»).
 *
 * Что проверяет: git и имя для истории, настройки и вход в Kaiten, файл
 * проекта, доску проекта, задачи на машине и доступ к их хранилищу, скилл и
 * блок правил в репозитории. Проверки со связью (`Kaiten`, хранилище задач)
 * отключаются флагом `--offline`.
 *
 * Правило вывода то же, что у остальных команд: где лежат задачи, не
 * называется. Файл настроек называется — его человек правит сам.
 *
 * Код выхода: 0 — работать можно (в том числе с предупреждениями); 1 — есть
 * то, без чего команды откажут.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { rulesState, SKILL_PATH, skillState } from './core/repo-connect.js';
import { belongsToProject, buildIndex } from './core/tasks-index.js';
import { CONFIG_PATH, invocationDir, loadPeople, parse, SETTINGS_PATH, storeMessage } from './kaiten-cli.js';
import { KaitenApiError, KaitenClient } from './kaiten-client.js';
import { findProjectFile, loadSettings, parseProjectFile, SettingsError, type KaitenSettings } from './kaiten-context.js';
import { readJournal } from './store-write.js';
import { defaultStorePath, gitNetwork, gitText, isStore, listEntries, readStoreTree, StoreError } from './task-store.js';

export const DOCTOR_HELP = `kaiten doctor — проверить, что всё готово к работе с задачами.

Проверяет машину (git, настройки, вход в Kaiten), этот репозиторий (подключён
ли, свежий ли скилл, есть ли правила) и задачи проекта (загружены ли, есть ли
доступ, всё ли отправлено). Про каждое «не так» говорит, что сделать.

Флаги:
  --offline           без проверок, которым нужна связь

Пример:
  kaiten doctor
`;

export interface Check {
  level: 'ok' | 'warn' | 'fail';
  what: string;
  /** Что сделать — для `warn` и `fail`. */
  fix?: string;
}

const MARK: Record<Check['level'], string> = { ok: '✓', warn: '!', fail: '✗' };

export function formatChecks(checks: readonly Check[]): string[] {
  const lines = checks.flatMap((c) => [`${MARK[c.level]} ${c.what}`, ...(c.fix ? [`    → ${c.fix}`] : [])]);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  const verdict = fails > 0 ? `Не готово: исправить ${fails}${warns > 0 ? `, предупреждений ${warns}` : ''}.` : warns > 0 ? `Работать можно; предупреждений ${warns}.` : 'Всё готово.';
  return [...lines, '', verdict];
}

const TOOL_SKILL = fileURLToPath(new URL('../skills/kaiten/SKILL.md', import.meta.url));
const OWNER = 'Это делает владелец проекта: npm run connect-repo в kaiten-tracker.';

function gitChecks(dir: string): Check[] {
  let version: string;
  try {
    version = gitText(dir, ['--version']);
  } catch {
    return [{ level: 'fail', what: 'git не найден', fix: 'Установите git и повторите.' }];
  }
  const checks: Check[] = [{ level: 'ok', what: version }];
  const get = (key: string): string => {
    try {
      return gitText(dir, ['config', key]);
    } catch {
      return '';
    }
  };
  const name = get('user.name');
  const email = get('user.email');
  if (name && email) checks.push({ level: 'ok', what: `имя для истории изменений: ${name} <${email}>` });
  else checks.push({ level: 'fail', what: 'не задано имя или почта git — изменения задач не записать', fix: 'git config --global user.name "…" и git config --global user.email "…"' });
  return checks;
}

function settingsChecks(email: string): { checks: Check[]; settings: KaitenSettings | null } {
  if (!existsSync(SETTINGS_PATH)) {
    return { checks: [{ level: 'warn', what: 'настроек kaiten нет: команды пишут задачи, но карточки Kaiten не обновляют', fix: `Создайте ${SETTINGS_PATH} по образцу kaiten.settings.example.json (или node scripts/install.mjs в kaiten-tracker).` }], settings: null };
  }
  let settings: KaitenSettings;
  try {
    settings = loadSettings(SETTINGS_PATH);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    return { checks: [{ level: 'fail', what: `не читаются ${error.message}`, fix: `Исправьте ${SETTINGS_PATH}.` }], settings: null };
  }
  const checks: Check[] = [];
  const people = loadPeople();
  const known = new Set(Object.values(people));
  if (settings.person) checks.push(known.has(settings.person) ? { level: 'ok', what: `вы в задачах — ${settings.person}` } : { level: 'warn', what: `вы в задачах — ${settings.person}, такого человека нет в реестре`, fix: 'Сверьте person в настройках с реестром людей у владельца проекта.' });
  else if (people[email.toLowerCase()]) checks.push({ level: 'ok', what: `вы в задачах — ${people[email.toLowerCase()]} (по почте git)` });
  else checks.push({ level: 'fail', what: 'не понять, кто вы: новую задачу не завести', fix: `Укажите person в ${SETTINGS_PATH}.` });
  if (!settings.sync.kaiten) checks.push({ level: 'warn', what: 'обновление Kaiten выключено: статусы и текст карточек команды не меняют', fix: `Включите sync.kaiten в ${SETTINGS_PATH}, когда владелец проекта скажет.` });
  else if (!settings.kaiten) checks.push({ level: 'fail', what: 'обновление Kaiten включено, а входа нет', fix: `Добавьте kaiten.domain и kaiten.token в ${SETTINGS_PATH}.` });
  return { checks, settings };
}

async function kaitenLogin(settings: KaitenSettings): Promise<Check> {
  if (!settings.kaiten) return { level: 'warn', what: 'входа в Kaiten в настройках нет — не проверяю' };
  try {
    await new KaitenClient({ ...settings.kaiten, maxRetries: 1 }).listSpaces();
    return { level: 'ok', what: 'вход в Kaiten работает' };
  } catch (error) {
    const status = error instanceof KaitenApiError ? error.status : -1;
    if (status === 401 || status === 403) return { level: 'fail', what: 'Kaiten не принял токен', fix: `Выпустите новый личный токен в Kaiten и запишите его в ${SETTINGS_PATH}.` };
    if (status === 0) return { level: 'warn', what: 'нет связи с Kaiten — вход не проверен', fix: 'Проверьте интернет и домен Kaiten в настройках; без связи: kaiten doctor --offline.' };
    return { level: 'warn', what: `Kaiten ответил неожиданно${status > 0 ? ` (${status})` : ''} — вход не проверен`, fix: 'Проверьте домен Kaiten в настройках.' };
  }
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

interface RepoFacts {
  checks: Check[];
  project?: { key: string; title: string; store: string; repos: string[]; hasBoard: boolean };
}

function repoChecks(workDir: string): RepoFacts {
  const path = findProjectFile(workDir);
  if (!path) return { checks: [{ level: 'fail', what: 'этот репозиторий не подключён к kaiten: нет файла .kaiten', fix: OWNER }] };
  const parsed = parseProjectFile(readFileSync(path, 'utf8'));
  if (!('file' in parsed)) return { checks: [{ level: 'fail', what: `файл .kaiten не читается${'error' in parsed ? `: ${parsed.error}` : ''}`, fix: OWNER }] };
  const { projects } = loadConfig(CONFIG_PATH);
  const project = projects[parsed.file.project];
  if (!project) return { checks: [{ level: 'fail', what: `в .kaiten проект «${parsed.file.project}», такого в kaiten нет (есть: ${Object.keys(projects).join(', ')})`, fix: 'Обновите kaiten-tracker (git pull) или исправьте .kaiten — вопрос к владельцу проекта.' }] };
  const repos = project.repos.map((r) => r.name);
  const checks: Check[] = [];
  if (repos.includes(parsed.file.repo)) checks.push({ level: 'ok', what: `репозиторий подключён: проект ${project.title}, продукт ${parsed.file.repo}` });
  else checks.push({ level: 'fail', what: `в .kaiten продукт «${parsed.file.repo}», в проекте ${project.title} такого нет (есть: ${repos.join(', ')})`, fix: OWNER });

  const root = dirname(path);
  const skill = skillState(readFileSync(TOOL_SKILL, 'utf8'), readOrNull(join(root, SKILL_PATH)));
  if (skill === 'fresh') checks.push({ level: 'ok', what: 'скилл kaiten в репозитории — свежий' });
  else checks.push({ level: 'warn', what: skill === 'missing' ? 'скилла kaiten в репозитории нет: агент не знает, как вести задачи' : 'скилл kaiten в репозитории устарел', fix: OWNER });

  const rules = ['CLAUDE.md', 'AGENTS.md'].map((name) => rulesState(readOrNull(join(root, name))));
  if (rules.includes('fresh')) checks.push({ level: 'ok', what: 'правила про задачи в репозитории есть' });
  else checks.push({ level: 'warn', what: rules.includes('stale') ? 'правила про задачи в репозитории устарели' : 'правил про задачи в CLAUDE.md нет: агент может чинить мимо задач', fix: OWNER });

  return { checks, project: { key: parsed.file.project, title: project.title, store: defaultStorePath(project.tasksRepo?.name ?? `${parsed.file.project}-tasks`), repos, hasBoard: project.mapping !== undefined } };
}

function storeChecks(project: NonNullable<RepoFacts['project']>, settings: KaitenSettings | null, offline: boolean): Check[] {
  const checks: Check[] = [];
  if (settings?.sync.kaiten && !project.hasBoard) checks.push({ level: 'fail', what: `у проекта ${project.title} не настроена доска Kaiten`, fix: 'Обновите kaiten-tracker (git pull); если не поможет — вопрос к владельцу проекта.' });
  if (!existsSync(project.store)) return [...checks, { level: 'fail', what: `задач проекта ${project.title} на этой машине ещё нет`, fix: 'kaiten pull' }];
  if (!isStore(project.store)) return [...checks, { level: 'fail', what: 'задачи проекта на этой машине повреждены', fix: 'kaiten pull — загрузит заново.' }];

  const tree = readStoreTree(project.store, listEntries(project.store));
  const index = buildIndex(tree.files, tree.logs);
  if (!belongsToProject(index.tasks, project.repos)) checks.push({ level: 'fail', what: `задачи на этой машине — другого проекта, не ${project.title}`, fix: 'Сообщите тому, кто настраивал kaiten.' });
  else checks.push({ level: 'ok', what: `задачи проекта ${project.title} загружены: открытых ${index.tasks.filter((t) => !t.closed).length}, всего ${index.tasks.length}` });
  if (index.problems.length > 0) checks.push({ level: 'warn', what: `не читается задач: ${index.problems.length}`, fix: 'kaiten list покажет, какие и что в них исправить.' });

  const journal = readJournal(project.store);
  if (journal.pending.length > 0) {
    checks.push({ level: 'warn', what: `ваших изменений ещё не отправлено: ${journal.pending.length}${journal.sendProblem ? `. ${storeMessage(journal.sendProblem.kind)}` : ''}`, fix: 'kaiten pull — отправит.' });
  } else checks.push({ level: 'ok', what: 'все ваши изменения отправлены' });
  if (journal.failed.length > 0) checks.push({ level: 'warn', what: `изменений не применено: ${journal.failed.length}`, fix: 'Любая команда kaiten скажет, какие и почему.' });
  if (journal.kaiten && journal.kaiten.errors.length > 0) checks.push({ level: 'warn', what: `Kaiten не обновлён: ${journal.kaiten.errors.map((e) => `${e.what} — ${e.reason}`).slice(0, 3).join('; ')}` });

  if (!offline) {
    try {
      gitNetwork(project.store, ['ls-remote', '--exit-code', 'origin', 'HEAD']);
      checks.push({ level: 'ok', what: 'доступ к хранилищу задач есть' });
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      checks.push({ level: error.kind === 'offline' ? 'warn' : 'fail', what: 'хранилище задач недоступно', fix: storeMessage(error.kind) });
    }
  }
  return checks;
}

export async function doctor(args: string[]): Promise<void> {
  const { values } = parse('doctor', args, { offline: { type: 'boolean' } }, 0);
  const offline = values.offline === true;
  const workDir = invocationDir();
  const checks: Check[] = [];

  const git = gitChecks(workDir);
  checks.push(...git);
  let email = '';
  try {
    email = gitText(workDir, ['config', 'user.email']);
  } catch {
    email = '';
  }
  const { checks: settingsResult, settings } = settingsChecks(email);
  checks.push(...settingsResult);
  if (settings?.sync.kaiten && settings.kaiten && !offline) checks.push(await kaitenLogin(settings));

  const repo = repoChecks(workDir);
  checks.push(...repo.checks);
  if (repo.project && git[0].level === 'ok') checks.push(...storeChecks(repo.project, settings, offline));

  console.log(formatChecks(checks).join('\n'));
  if (checks.some((c) => c.level === 'fail')) process.exitCode = 1;
}
