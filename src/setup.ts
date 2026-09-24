/**
 * Заводит в Kaiten структуру под схему эпика: пространство, доску с колонкой
 * на каждый статус, типы карточек, селект приоритета, поле репозитория — и
 * записывает их id в блок `kaiten` файла `tracker.config.json`.
 *
 * ЗАЧЕМ. Маппинг заливки ссылается на id колонок, типов и свойств, а в новом
 * аккаунте их нет. Руками это 20 с лишним кликов и опечатка в id на выходе;
 * скрипт делает то же одним прогоном и повторяем.
 *
 * БЕЗОПАСНОСТЬ ПО УМОЛЧАНИЮ. Без `--apply` — только чтение и план. Существующее
 * находится по имени и не создаётся второй раз; ничего не удаляется и не
 * переименовывается. Повторный прогон после `--apply` даёт пустой план.
 *
 * ФЛАГИ
 *   --apply            создать недостающее и записать маппинг в конфиг
 *   --config <path>    конфиг (по умолч. tracker.config.json)
 *
 * ENV: `KAITEN_DOMAIN`, `KAITEN_TOKEN`. Запуск: `npm run setup` / `npm run setup -- --apply`.
 *
 * Коды выхода: 0 — ок; 2 — нет токена; 6 — ошибка запроса.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { KaitenApiError, KaitenClient } from './kaiten-client.js';
import { buildMapping, DESIRED, findBoard, findProperty, findSpace, planSetup, type CurrentStructure, type SetupAction } from './setup-plan.js';

async function readCurrent(client: KaitenClient): Promise<CurrentStructure> {
  const spaces = await client.listSpaces();
  const current: CurrentStructure = {
    spaces,
    boards: [],
    cardTypes: await client.listCardTypes(),
    properties: await client.listCustomProperties(),
    priorityValues: [],
  };
  const space = findSpace(current, DESIRED);
  if (space) current.boards = await client.listBoards(space.id);
  const priority = findProperty(current, DESIRED.priority.name);
  if (priority) current.priorityValues = await client.listSelectValues(priority.id);
  return current;
}

function describe(action: SetupAction): string {
  switch (action.kind) {
    case 'create-space':
      return `пространство «${action.title}»`;
    case 'create-board':
      return `доска «${action.title}» с колонками: ${action.columns.map((c) => `${c.title} [${c.type}]`).join(', ')}`;
    case 'create-column':
      return `колонка «${action.title}» [${action.type}]`;
    case 'create-card-type':
      return `тип карточки «${action.name}» (${action.letter})`;
    case 'create-property':
      return `свойство «${action.name}» (${action.type})`;
    case 'create-select-value':
      return `вариант «${action.value}» свойства «${action.property}»`;
  }
}

/**
 * Выполняет план по порядку. После создания пространства и свойств состояние
 * перечитывается: ответ на создание пространства по документации отдаёт `uid`,
 * а не числовой `id`, который нужен дальше, — надёжнее найти его по имени.
 */
async function apply(client: KaitenClient, actions: SetupAction[]): Promise<void> {
  let current = await readCurrent(client);
  for (const action of actions) {
    console.log(`  + ${describe(action)}`);
    switch (action.kind) {
      case 'create-space':
        await client.createSpace(action.title);
        current = await readCurrent(client);
        break;
      case 'create-board': {
        const space = findSpace(current, DESIRED);
        if (!space) throw new Error(`Пространство «${DESIRED.space}» не нашлось после создания`);
        await client.createBoard(space.id, action.title, action.columns);
        current = await readCurrent(client);
        break;
      }
      case 'create-column': {
        const board = findBoard(current, DESIRED);
        if (!board) throw new Error(`Доска «${DESIRED.board}» не найдена`);
        await client.createColumn(board.id, { title: action.title, type: action.type, sort_order: action.sortOrder });
        break;
      }
      case 'create-card-type':
        await client.createCardType({ name: action.name, letter: action.letter, color: action.color });
        break;
      case 'create-property':
        await client.createCustomProperty({ name: action.name, type: action.type });
        current = await readCurrent(client);
        break;
      case 'create-select-value': {
        const property = findProperty(current, action.property);
        if (!property) throw new Error(`Свойство «${action.property}» не найдено`);
        await client.createSelectValue(property.id, action.value);
        break;
      }
    }
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const doApply = argv.includes('--apply');
  const configPath = argValue(argv, '--config') ?? 'tracker.config.json';
  const domain = process.env.KAITEN_DOMAIN ?? '';
  const token = process.env.KAITEN_TOKEN ?? '';
  if (!domain || !token) {
    console.error('Нужны KAITEN_DOMAIN и KAITEN_TOKEN в окружении (`--env-file=.env`).');
    process.exit(2);
  }

  const client = new KaitenClient({ domain, token });
  const plan = planSetup(await readCurrent(client));

  console.log(doApply ? 'APPLY — создаю недостающее' : 'DRY-RUN — ничего не создаётся, только план');
  console.log(`Уже есть (${plan.reused.length}):`);
  for (const line of plan.reused) console.log(`  = ${line}`);
  console.log(`Лишнее в аккаунте — не трогаем (${plan.extra.length}):`);
  for (const line of plan.extra) console.log(`  · ${line}`);
  console.log(`Создать (${plan.actions.length}):`);
  if (!doApply) for (const action of plan.actions) console.log(`  + ${describe(action)}`);

  if (doApply && plan.actions.length > 0) await apply(client, plan.actions);

  if (!doApply) {
    console.log(plan.actions.length === 0 ? 'План пуст: структура заведена. `--apply` запишет маппинг в конфиг.' : 'Чтобы создать: `npm run setup -- --apply`.');
    console.log(`Запросов: ${client.requestCount}`);
    if (plan.actions.length > 0) return;
  }

  const mapping = buildMapping(await readCurrent(client));
  if (doApply) {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.kaiten = mapping;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    console.log(`Маппинг записан в ${configPath}`);
  }
  console.log(JSON.stringify(mapping, null, 2));
  console.log(`Запросов: ${client.requestCount}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  // Проверено живьём 23.09.2026: у не-админа named_permissions.cardTypes и
  // customProperties = false, и создание типов и свойств отвечает 403.
  if (error instanceof KaitenApiError && error.status === 403) {
    console.error(
      'Нет прав у пользователя токена: типы карточек и пользовательские поля заводит администратор компании ' +
        '(или выдайте эти права в ролях). Уже созданное сохранится — повторный запуск продолжит с места остановки.',
    );
  }
  process.exit(6);
});
