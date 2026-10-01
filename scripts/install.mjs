#!/usr/bin/env node
// Установка kaiten на машину разработчика. Запускается из склонированного kaiten-tracker:
//
//   node scripts/install.mjs [--domain <домен Kaiten>] [--person <кто вы>] [--no-kaiten] [--check]
//
// Делает по порядку: проверяет Node.js и git → ставит зависимости → кладёт команду `kaiten` в PATH
// (`npm link`) → создаёт `kaiten.settings.json` с вашим личным входом в Kaiten → проверяет, что
// команда отвечает. Повторный запуск безопасен: готовые шаги пропускаются, настройки не
// перезаписываются. `--check` — только показать, что уже сделано.
//
// Токен Kaiten: из переменной окружения KAITEN_TOKEN или вопросом без показа ввода. Он пишется
// только в kaiten.settings.json (файл в .gitignore) и не печатается никогда.
//
// Обычный node без зависимостей: до `npm install` в папке нет ни tsx, ни zod.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = join(ROOT, 'kaiten.settings.json');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const checkOnly = flag('--check');
const isWin = process.platform === 'win32';

const ok = (text) => console.log(`✓ ${text}`);
const todo = (text) => console.log(`· ${text}`);
function fail(text, fix) {
  console.error(`✗ ${text}${fix ? `\n    → ${fix}` : ''}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  // npm на Windows — это npm.cmd: без оболочки его не запустить.
  // Аргументы здесь — только наши константы без пробелов, поэтому на Windows склеиваем их в строку.
  return isWin
    ? spawnSync([cmd, ...args].join(' '), { cwd: ROOT, encoding: 'utf8', shell: true, windowsHide: true, ...options })
    : spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...options });
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Вопрос печатаем сами, а эхо ввода глушим: токен не должен остаться на экране и в истории.
      process.stdout.write(question);
      rl._writeToOutput = () => {};
      rl.question('', (answer) => {
        rl.close();
        process.stdout.write('\n');
        resolveAnswer(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolveAnswer(answer.trim());
      });
    }
  });
}

// ── 1. Node.js и git ─────────────────────────────────────────────────────
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) fail(`Node.js ${process.versions.node} — нужен 20 или новее`, 'Обновите Node.js: https://nodejs.org');
ok(`Node.js ${process.versions.node}`);

let gitVersion = '';
try {
  gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
} catch {
  fail('git не найден', 'Установите git: https://git-scm.com');
}
ok(gitVersion);

const gitConfig = (key) => {
  try {
    return execFileSync('git', ['config', '--global', key], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
};
const gitName = gitConfig('user.name');
const gitEmail = gitConfig('user.email');
if (gitName && gitEmail) ok(`имя для истории изменений: ${gitName} <${gitEmail}>`);
else fail('не задано имя или почта git', 'git config --global user.name "Имя Фамилия" и git config --global user.email "почта"');

// ── 2. Зависимости ───────────────────────────────────────────────────────
if (existsSync(join(ROOT, 'node_modules', 'tsx')) && existsSync(join(ROOT, 'node_modules', 'zod'))) ok('зависимости установлены');
else if (checkOnly) todo('зависимости не установлены (npm install)');
else {
  console.log('… ставлю зависимости (npm install)');
  const r = run('npm', ['install', '--no-audit', '--no-fund']);
  if (r.status !== 0) fail('npm install не прошёл', (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' '));
  ok('зависимости установлены');
}

// ── 3. Команда kaiten в PATH ─────────────────────────────────────────────
/** Папка, куда npm link кладёт команды: на Windows — сам prefix, на Linux/macOS — prefix/bin. */
function globalBin() {
  const r = run('npm', ['prefix', '-g']);
  const prefix = r.status === 0 ? (r.stdout ?? '').trim() : '';
  if (!prefix) return undefined;
  return isWin ? prefix : join(prefix, 'bin');
}
function kaitenAnswers() {
  const r = run('kaiten', ['--help'], { cwd: dirname(ROOT) });
  return r.status === 0 && /задачи проекта/.test(r.stdout ?? '');
}
if (kaitenAnswers()) ok('команда kaiten в PATH');
else if (checkOnly) todo('команды kaiten в PATH нет (npm link)');
else {
  console.log('… подключаю команду kaiten (npm link)');
  const r = run('npm', ['link']);
  const output = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  // Linux/macOS: глобальная папка npm принадлежит root (/usr/local), обычному пользователю туда не записать.
  // sudo не советуем: папка kaiten-tracker и кеш npm станут чужими. Своя папка для глобальных пакетов — штатный путь npm.
  if (r.status !== 0 && !isWin && /EACCES|permission denied/i.test(output)) {
    fail(
      `npm link не прошёл: нет прав на запись в папку глобальных пакетов npm (${globalBin() ?? 'npm prefix -g'})`,
      'Заведите свою папку для глобальных пакетов npm и запустите установку снова:\n' +
        '      npm config set prefix ~/.npm-global\n' +
        "      echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.bashrc   (для zsh — ~/.zshrc)\n" +
        '      откройте новый терминал и запустите node scripts/install.mjs ещё раз',
    );
  }
  if (r.status !== 0) fail('npm link не прошёл', output.trim().split('\n').slice(-3).join(' '));
  if (!kaitenAnswers()) {
    const bin = globalBin();
    fail(
      'команда kaiten не находится после npm link',
      `Добавьте в PATH папку ${bin ?? 'глобальных пакетов npm (npm prefix -g)'} и откройте новый терминал${isWin ? '' : ` — например, echo 'export PATH="${bin ?? '<папка>'}:$PATH"' >> ~/.bashrc`}.`,
    );
  }
  ok('команда kaiten в PATH');
}

// ── 4. Настройки: личный вход в Kaiten ───────────────────────────────────
if (existsSync(SETTINGS)) {
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch {
    fail('kaiten.settings.json не разбирается', `Исправьте или удалите ${SETTINGS} и запустите установку снова.`);
  }
  ok(`настройки есть (${parsed?.kaiten ? 'вход в Kaiten задан' : 'без входа в Kaiten'}, обновление Kaiten ${parsed?.sync?.kaiten ? 'включено' : 'выключено'}) — не трогаю`);
} else if (checkOnly) todo('настроек нет (kaiten.settings.json)');
else {
  // Кто вы в задачах — по реестру людей проекта (он в репозитории задач) по почте git.
  // --person — только если почта в реестре другая; сверит kaiten doctor после первого pull.
  const person = value('--person');
  const settings = { sync: { kaiten: false }, ...(person ? { person } : {}), localCopy: { enabled: false } };
  if (!flag('--no-kaiten')) {
    let domain = value('--domain') ?? process.env.KAITEN_DOMAIN;
    let token = process.env.KAITEN_TOKEN;
    if ((!domain || !token) && !process.stdin.isTTY) fail('нет домена или токена Kaiten', 'Задайте --domain и переменную KAITEN_TOKEN, запустите в терминале или добавьте --no-kaiten.');
    if (!domain) domain = await ask('Домен Kaiten (например company.kaiten.ru): ');
    if (!token) token = await ask('Личный токен Kaiten (Профиль → API-ключи; ввод не показывается): ', { hidden: true });
    domain = (domain ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!domain || !token) fail('домен и токен Kaiten обязательны', 'Или запустите с --no-kaiten: задачи будут вестись, карточки — нет.');

    // Проверяем вход до записи: битый токен хуже, чем его отсутствие.
    let status = 0;
    try {
      const response = await fetch(`https://${domain}/api/latest/users/current`, { headers: { Authorization: `Bearer ${token}` } });
      status = response.status;
    } catch {
      status = -1;
    }
    if (status === 401 || status === 403) fail('Kaiten не принял токен', 'Выпустите новый личный токен и запустите установку снова.');
    if (status === -1) console.log('! нет связи с Kaiten — вход не проверен, настройки записываю как есть');
    else if (status !== 200) console.log(`! Kaiten ответил ${status} — проверьте домен; настройки записываю как есть`);
    else ok('вход в Kaiten работает');
    settings.kaiten = { domain, token };
    settings.sync.kaiten = true;
  }
  const ordered = { ...(settings.kaiten ? { kaiten: settings.kaiten } : {}), sync: settings.sync, person: settings.person, localCopy: settings.localCopy };
  writeFileSync(SETTINGS, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  ok(`настройки записаны: ${person ? `вы — ${person}, ` : ""}обновление Kaiten ${settings.sync.kaiten ? 'включено' : 'выключено'}`);
}

// ── Что дальше ───────────────────────────────────────────────────────────
console.log(`
${checkOnly ? 'Проверка закончена.' : 'Установка закончена.'} Дальше — в репозитории кода проекта:
  kaiten doctor    проверит репозиторий, доступ к задачам и скажет, чего не хватает
  kaiten pull      загрузит задачи проекта (нужен доступ к репозиторию задач на GitHub)
Обновлять инструмент: git pull в ${ROOT} (и npm install, если изменился package.json).`);
