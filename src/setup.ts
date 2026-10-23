/**
 * Заводит в Kaiten структуру проекта под схему эпика: пространство, доску с
 * колонкой на каждый статус, типы карточек, поля-выборы приоритета, команды и
 * репозитория проекта — и записывает их id в `mapping` файла `kaiten.json`
 * рабочей копии репозитория задач (закоммитить и отправить — руками).
 *
 * ЗАЧЕМ. Маппинг заливки ссылается на id колонок, типов и свойств, а в новом
 * аккаунте их нет. Руками это 20 с лишним кликов и опечатка в id на выходе;
 * скрипт делает то же одним прогоном и повторяем.
 *
 * БЕЗОПАСНОСТЬ ПО УМОЛЧАНИЮ. Без `--apply` — только чтение и план. Существующее
 * находится по имени и не создаётся второй раз; ничего не удаляется.
 * Переименовывается и переносится только пространство разработки — когда в
 * `kaiten.json` ему задали новое имя или папку (находится по доске из прошлого
 * `setup`). Повторный прогон после `--apply` даёт пустой план.
 *
 * ФЛАГИ
 *   --tasks <папка>    рабочая копия репозитория задач проекта (с kaiten.json)
 *   --config <путь>    kaiten.json не из репозитория задач (пробные прогоны)
 *   --apply            создать недостающее и записать маппинг в kaiten.json
 *
 * ENV: `KAITEN_DOMAIN`, `KAITEN_TOKEN`. Запуск: `npm run setup` / `npm run setup -- --apply`.
 *
 * Коды выхода: 0 — ок; 2 — нет токена; 6 — ошибка запроса.
 */

import { saveMapping, type ConfigMapping, type LoadedProject } from './config.js';
import { KaitenApiError, KaitenClient, type CardType } from './kaiten-client.js';
import { loadOwnerProject } from './owner-project.js';

import {
  buildMapping,
  findBoard,
  findSelect,
  findCardType,
  findSpace,
  findFolder,
  findText,
  typeRequires,
  typeSuggests,
  typeHas,
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
    folder: project.kaiten.folder,
    knownBoardId: project.mapping?.boardId,
    repoLanes: Object.fromEntries(project.repos.flatMap((r) => (r.lane ? [[r.name, r.lane]] : []))),
    archiveLane: project.kaiten.archiveLane,
    departments: project.kaiten.departments,
    junior: project.kaiten.junior !== undefined,
    visual: project.kaiten.visual !== undefined,
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
  const selects = [
    ...SELECT_ROLES.map((role) => desired.selects[role].name),
    ...(desired.junior ? [desired.junior.select.name, desired.junior.assess.name] : []),
    ...(desired.visual ? [desired.visual.name] : []),
  ];
  for (const name of selects) {
    const property = findSelect(current, name);
    if (property) current.selectValues[property.id] = await client.listSelectValues(property.id);
  }
  return current;
}

function describe(action: SetupAction): string {
  switch (action.kind) {
    case 'create-folder':
      return `папка «${action.title}» (пространство верхнего уровня)`;
    case 'move-space': {
      const parts = [action.from !== action.title ? `переименовать в «${action.title}»` : '', action.folder ? `положить в папку «${action.folder}»` : ''].filter(Boolean);
      return `пространство «${action.from}» (${action.id}): ${parts.join(', ')} — доска, карточки и ограничения остаются`;
    }
    case 'create-space':
      return `пространство «${action.title}»`;
    case 'create-lane':
      return `дорожка «${action.title}»`;
    case 'create-department':
      return `пространство отдела «${action.space}» в папке, доска «${action.board}»: ${action.columns.map((c) => c.title).join(' → ')}`;
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
    case 'add-type-property':
      return `поле «${action.property}» в типе «${action.typeName}» (не обязательно)`;
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
      case 'create-folder':
        await client.createSpace(action.title);
        current = await readCurrent(client, desired);
        break;
      case 'move-space': {
        const folder = findFolder(current, desired);
        if (action.folder && !folder?.uid) throw new Error(`Папка «${action.folder}» не нашлась`);
        const saved = await client.updateSpace(action.id, { title: action.title, ...(folder?.uid ? { parent_entity_uid: folder.uid } : {}) });
        if (saved.title !== action.title || (folder?.uid && saved.parent_entity_uid !== folder.uid)) throw new Error(`Пространство «${action.from}» не переименовалось или не переехало в папку`);
        current = await readCurrent(client, desired);
        break;
      }
      case 'create-space':
        await client.createSpace(action.title, findFolder(current, desired)?.uid);
        current = await readCurrent(client, desired);
        break;
      case 'create-lane': {
        const board = findBoard(current, desired);
        if (!board) throw new Error(`Доска «${desired.board}» не найдена`);
        await client.createLane(board.id, { title: action.title, sort_order: action.sortOrder });
        break;
      }
      case 'create-department': {
        const folder = findFolder(current, desired);
        if (!folder?.uid) throw new Error(`Папка «${desired.folder ?? ''}» не нашлась`);
        await client.createSpace(action.space, folder.uid);
        current = await readCurrent(client, desired);
        const space = current.spaces.find((s) => s.title === action.space && s.parent_entity_uid === folder.uid);
        if (!space) throw new Error(`Пространство отдела «${action.space}» не нашлось после создания`);
        await client.createBoard(space.id, action.board, action.columns);
        break;
      }
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
      case 'add-type-property': {
        current = await readCurrent(client, desired);
        const type = findCardType(current, action.typeName);
        const property = action.propertyType === 'select' ? findSelect(current, action.property) : findText(current, action.property);
        if (!type || !property?.uid) throw new Error(`Нет типа «${action.typeName}» или поля «${action.property}» с uid`);
        const request = typePropertiesRequest(type);
        const last = Math.max(0, ...request.map((p) => p.sort_order ?? 0)) + 1;
        request.push({ regular_property: null, property_uid: property.uid, sort_order: last, required: false });
        await client.updateCardType(type.id, { name: type.name, card_properties: request });
        const saved = await client.getCardType(type.id);
        if (!typeHas(saved, property)) throw new Error(`Поле «${property.name}» не добавилось в тип «${type.name}»`);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const doApply = argv.includes('--apply');
  const domain = process.env.KAITEN_DOMAIN ?? '';
  const token = process.env.KAITEN_TOKEN ?? '';
  if (!domain || !token) {
    console.error('Нужны KAITEN_DOMAIN и KAITEN_TOKEN в окружении (`--env-file=.env`).');
    process.exit(2);
  }

  const owner = loadOwnerProject(argv);
  if (owner.source.kind === 'store') throw new Error('setup пишет id в kaiten.json — нужна рабочая копия: --tasks <папка>');
  const { loaded } = owner;
  const configPath = owner.source.configPath;
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
    console.log(`Маппинг записан в ${configPath} → mapping. Закоммитьте и отправьте репозиторий задач.`);
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
