/**
 * Заводит в Kaiten структуру проекта под схему эпика: пространство, доску с
 * колонкой на каждый статус, типы карточек, поля-выборы приоритета, команды и
 * репозитория проекта — и записывает их id в `projects.<проект>.mapping`
 * файла `tracker.config.json`.
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
 *   --project <key>    проект из конфига (обязателен, если проектов несколько)
 *   --config <path>    конфиг (по умолч. tracker.config.json)
 *
 * ENV: `KAITEN_DOMAIN`, `KAITEN_TOKEN`. Запуск: `npm run setup` / `npm run setup -- --apply`.
 *
 * Коды выхода: 0 — ок; 2 — нет токена; 6 — ошибка запроса.
 */

import { loadProject, saveMapping, type ConfigMapping, type LoadedProject } from './config.js';
import { KaitenApiError, KaitenClient, type CardType } from './kaiten-client.js';

import {
  buildMapping,
  findBoard,
  findSelect,
  findCardType,
  findSpace,
  findText,
  typeRequires,
  typeSuggests,
  planSetup,
  SELECT_ROLES,
  desiredForProject,
  type CurrentStructure,
  type KaitenMapping,
  type DesiredStructure,
  type SetupAction,
} from './setup-plan.js';

/** Варианты полей берутся из конфига: список репозиториев и команд решает владелец. */
function desiredFor(loaded: LoadedProject): DesiredStructure {
  const { project, config } = loaded;
  return desiredForProject({
    space: project.kaiten.space,
    board: project.kaiten.board,
    repoField: project.kaiten.repoField,
    repoLabels: project.repos.map((r) => r.label),
    teams: config.teams,
    retire: project.retireFields,
  });
}

/**
 * В Kaiten варианты поля репозитория подписаны для людей (`Acme-android`),
 * а в задаче стоит имя репозитория на GitHub (`acme-mobile`). Импорт
 * ищет вариант по имени, поэтому в конфиг значения пишутся по имени.
 */
function toConfigMapping(mapping: KaitenMapping, loaded: LoadedProject): ConfigMapping {
  if (!mapping.repoProperty) return mapping;
  const byName: Record<string, number> = {};
  for (const repo of loaded.project.repos) {
    const id = mapping.repoProperty.values[repo.label];
    if (id !== undefined) byName[repo.name] = id;
  }
  return { ...mapping, repoProperty: { id: mapping.repoProperty.id, values: byName } };
}

async function readCurrent(client: KaitenClient, desired: DesiredStructure): Promise<CurrentStructure> {
  const spaces = await client.listSpaces();
  const current: CurrentStructure = {
    spaces,
    boards: [],
    cardTypes: await client.listCardTypes(),
    properties: await client.listCustomProperties(),
    selectValues: {},
  };
  const space = findSpace(current, desired);
  if (space) current.boards = await client.listBoards(space.id);
  for (const role of SELECT_ROLES) {
    const property = findSelect(current, desired.selects[role].name);
    if (property) current.selectValues[property.id] = await client.listSelectValues(property.id);
  }
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
    case 'retire-property':
      return `отключить поле «${action.name}» (${action.id}) и переименовать в «${action.newName}» — значения на карточках остаются`;
    case 'create-property':
      return `поле «${action.name}» (${action.type})`;
    case 'create-select-value':
      return `вариант «${action.value}» свойства «${action.property}»`;
    case 'set-type-template':
      return `шаблон описания типа «${action.typeName}»: ${action.template.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3)).join(' / ')}`;
    case 'require-type-property':
      return `поле «${action.property}» обязательно в типе «${action.typeName}»`;
    case 'suggest-type-field':
      return `стандартное поле «${action.field}» предлагается (не обязательно) в типе «${action.typeName}»`;
  }
}

/** Поля типа в форме запроса: `PATCH` заменяет список целиком, поэтому имеющиеся передаём обратно. */
function typePropertiesRequest(type: CardType): Array<{ regular_property: string | null; property_uid: string | null; sort_order?: number; required: boolean }> {
  return (type.card_properties ?? []).map((p) => ({
    regular_property: p.regular_property ?? null,
    property_uid: p.property_uid ?? null,
    sort_order: p.sort_order,
    required: p.required ?? false,
  }));
}

/**
 * Выполняет план по порядку. После создания пространства и свойств состояние
 * перечитывается: ответ на создание пространства по документации отдаёт `uid`,
 * а не числовой `id`, который нужен дальше, — надёжнее найти его по имени.
 */
async function apply(client: KaitenClient, actions: SetupAction[], desired: DesiredStructure): Promise<void> {
  let current = await readCurrent(client, desired);
  for (const action of actions) {
    console.log(`  + ${describe(action)}`);
    switch (action.kind) {
      case 'create-space':
        await client.createSpace(action.title);
        current = await readCurrent(client, desired);
        break;
      case 'create-board': {
        const space = findSpace(current, desired);
        if (!space) throw new Error(`Пространство «${desired.space}» не нашлось после создания`);
        await client.createBoard(space.id, action.title, action.columns);
        current = await readCurrent(client, desired);
        break;
      }
      case 'create-column': {
        const board = findBoard(current, desired);
        if (!board) throw new Error(`Доска «${desired.board}» не найдена`);
        await client.createColumn(board.id, { title: action.title, type: action.type, sort_order: action.sortOrder });
        break;
      }
      case 'create-card-type':
        await client.createCardType({ name: action.name, letter: action.letter, color: action.color });
        break;
      case 'retire-property':
        await client.updateCustomProperty(action.id, { name: action.newName, condition: 'inactive' });
        current = await readCurrent(client, desired);
        break;
      case 'create-property':
        await client.createCustomProperty({ name: action.name, type: action.type });
        current = await readCurrent(client, desired);
        break;
      case 'create-select-value': {
        const property = findSelect(current, action.property);
        if (!property) throw new Error(`Свойство «${action.property}» не найдено`);
        await client.createSelectValue(property.id, action.value);
        break;
      }
      // Изменения типов перечитываются сразу: API Kaiten молча выбрасывает
      // незнакомое (грабли 23.09 с автоматизациями), и «200» ничего не доказывает.
      case 'set-type-template': {
        current = await readCurrent(client, desired);
        const type = findCardType(current, action.typeName);
        if (!type) throw new Error(`Тип «${action.typeName}» не найден`);
        await client.updateCardType(type.id, { name: type.name, description_template: action.template });
        const saved = await client.getCardType(type.id);
        if (saved.description_template !== action.template) throw new Error(`Шаблон типа «${type.name}» не сохранился`);
        break;
      }
      case 'require-type-property': {
        current = await readCurrent(client, desired);
        const type = findCardType(current, action.typeName);
        const property = findText(current, action.property);
        if (!type || !property?.uid) throw new Error(`Нет типа «${action.typeName}» или поля «${action.property}» с uid`);
        const request = typePropertiesRequest(type).filter((p) => p.property_uid !== property.uid);
        // «Суть» — первым полем типа.
        const first = Math.min(0, ...request.map((p) => p.sort_order ?? 0)) - 1;
        request.push({ regular_property: null, property_uid: property.uid, sort_order: first, required: true });
        await client.updateCardType(type.id, { name: type.name, card_properties: request });
        const saved = await client.getCardType(type.id);
        if (!typeRequires(saved, property)) throw new Error(`Поле «${property.name}» не стало обязательным в типе «${type.name}»`);
        break;
      }
      case 'suggest-type-field': {
        current = await readCurrent(client, desired);
        const type = findCardType(current, action.typeName);
        if (!type) throw new Error(`Тип «${action.typeName}» не найден`);
        const request = typePropertiesRequest(type);
        const last = Math.max(0, ...request.map((p) => p.sort_order ?? 0)) + 1;
        request.push({ regular_property: action.field, property_uid: null, sort_order: last, required: false });
        await client.updateCardType(type.id, { name: type.name, card_properties: request });
        const saved = await client.getCardType(type.id);
        if (!typeSuggests(saved, action.field)) throw new Error(`Поле «${action.field}» не добавилось в тип «${type.name}»`);
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

  const loaded = loadProject(configPath, argValue(argv, '--project') ?? null);
  const client = new KaitenClient({ domain, token, minIntervalMs: 150 });
  const desired = desiredFor(loaded);
  console.log(`Проект: ${loaded.project.title} (${loaded.key}) → пространство «${desired.space}», доска «${desired.board}»`);
  const plan = planSetup(await readCurrent(client, desired), desired);

  console.log(doApply ? 'APPLY — создаю недостающее' : 'DRY-RUN — ничего не создаётся, только план');
  console.log(`Уже есть (${plan.reused.length}):`);
  for (const line of plan.reused) console.log(`  = ${line}`);
  console.log(`Лишнее в аккаунте — не трогаем (${plan.extra.length}):`);
  for (const line of plan.extra) console.log(`  · ${line}`);
  console.log(`Создать (${plan.actions.length}):`);
  if (!doApply) for (const action of plan.actions) console.log(`  + ${describe(action)}`);

  if (doApply && plan.actions.length > 0) await apply(client, plan.actions, desired);

  if (!doApply) {
    console.log(plan.actions.length === 0 ? 'План пуст: структура заведена. `--apply` запишет маппинг в конфиг.' : 'Чтобы создать: `npm run setup -- --apply`.');
    console.log(`Запросов: ${client.requestCount}`);
    if (plan.actions.length > 0) return;
  }

  const mapping = toConfigMapping(buildMapping(await readCurrent(client, desired), desired), loaded);
  if (doApply) {
    saveMapping(configPath, loaded.key, mapping);
    console.log(`Маппинг записан в ${configPath} → projects.${loaded.key}.mapping`);
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
