# API Kaiten: что проверено на живом аккаунте

Официальная документация описывает не всё, а незнакомое API часто **молча
выбрасывает** (ответ 200, поле не сохранено). Поэтому любую новую конструкцию
проверяйте на безвредном действии и перечитывайте сохранённый объект. Ниже — то,
что проверено запросами к живому аккаунту (сентябрь — октябрь 2026).

## Карточки

- `GET /cards?board_id=…` отдаёт `column_id`, `type_id`, `properties`,
  `due_date`, `column_changed_at` (UTC ISO), `owner` (email, имя), `version`,
  `parents_ids`, `children_ids`, архивные тоже. Нет описания, пунктов
  чек-листов и участников — только в `GET /cards/{id}` (пункт: `id, text,
  checked, sort_order`; участник с `type` 2 — ответственный).
- `GET /cards?external_id=` — точное совпадение; архивные находятся.
  Карточки удалённого пространства не находятся ни по `external_id`, ни по id
  (403).
- Поле-выбор — массив id варианта (`id_<поле>: [<id варианта>]`), строка —
  строка (`id_<поле>: "…"`).
- Описание пустой карточки — `null`. Если карточку создать без описания (и
  через API тоже), Kaiten подставит шаблон описания её типа.
- Markdown-чекбоксы описание не отображает, а редактор экранирует их в `\[ \]`
  — пункты нужно класть в нативные чек-листы.
- Срок: `PATCH {due_date: "2026-10-15"}` → `"2026-10-15T00:00:00.000Z"` и
  `due_date_time_present: false`. Дату без времени берите как есть: перевод в
  местное время западнее UTC сдвинет срок на день.
- Эпик и задача: `POST /cards/{эпик}/children {card_id}` — у задачи
  `parents_ids` = эпик. После архивации эпика у задачи родитель может пропасть,
  у эпика ребёнок остаётся.
- Пункт чек-листа: `PATCH /cards/{id}/checklists/{cl}/items/{item}` — и
  отметка, и текст, и `sort_order` (дробный тоже: `0.5`). Порядок пунктов в
  ответе `GET` не по `sort_order`, в интерфейсе — по нему.
- Удаление: пункт — `DELETE /cards/{id}/checklists/{cl}/items/{item}`,
  чек-лист с пунктами — `DELETE /cards/{id}/checklists/{cl}`; оба отвечают
  `{id}` (16.10.2026).
- Комментарий: `POST /cards/{id}/comments {text}` — `type` 1, текст как
  отправлен.
- Всплеск записей обрывается сетевой ошибкой ниже заявленных лимитов —
  массовые команды стоит слать с паузой (150 мс достаточно); чтение после обрыва
  повторять можно, запись — нет (дубль).

## Списки

- Больше 100 записей за запрос Kaiten не отдаёт; без `limit` — тоже 100.
  `limit` и `offset` понимают (16.10.2026): `/cards`, `/spaces`,
  `/card-types`, `/company/custom-properties` и их `select-values`,
  `/spaces/{id}/restrictions`, `/cards/{id}/comments`, `/tree-entities`,
  `/documents?query=`. Клиент читает их все постранично (`listAll`).
- `/spaces/{id}/boards` параметры не понимает и отдаёт список целиком.
- `GET /boards/{id}` пока отдаёт и `cards` (первые 100); Kaiten убирает их
  с 1 ноября 2026. Мы берём оттуда только колонки, дорожки и описание;
  карточки доски — через `GET /cards?board_id=`.

## Файлы карточки

Проверено живьём 16.10.2026, файлы с ограниченным доступом
(developers.kaiten.ru/restricted-access-files-migration).

- Старая загрузка `PUT /cards/{id}/files` в аккаунте с запретом в настройках
  компании отвечает 403 `PUBLIC_API_LEGACY_FILE_UPLOAD_DISABLED`.
- Загрузка: `POST /cards/{uid}/files`, `multipart/form-data`, поле `file`,
  один файл за запрос. Адрес — по `uid` карточки (он есть и в
  `GET /cards`); с числовым id, по документации, файл ложится без защиты
  доступа с постоянной публичной ссылкой.
- Путь в имени файла сервер отрезает (`img/scheme.md` → `scheme.md`);
  `PATCH /cards/{uid}/files/{id} {name}` имя с `/` сохраняет.
- Тот же файл ещё раз — второй файл с тем же именем, а не замена.
- Список — `files` в `GET /cards/{id}` (в `GET /cards` его нет): `id`
  (UUID), `name`, `size` (строкой), `mime_type`, `type` 11. Старые файлы —
  `type` 1 и числовой `id`.
- Содержимое: `GET /cards/{uid}/files/{id}` — `url` с временной подписанной
  ссылкой; по ней — без токена.
- Удаление: `DELETE /cards/{uid}/files/{id}` → `{id}`.
- 5 МБ (предел `kaiten attach`) загружаются.

## Типы карточек и поля

- Типы и пользовательские поля компании заводит только администратор
  компании; роль в пространстве прав на них не даёт.
- `PATCH /card-types/{id}` требует одно из `letter/name/color/properties/
  card_properties` (иначе 400); `description_template` (нет в документации)
  принимается вместе с `name`. `card_properties` заменяется целиком:
  `[{ property_uid | regular_property, sort_order, required }]`,
  `regular_property` — size/due_date/tags/timeline/description.
- Обязательное поле типа в интерфейсе — только предупреждение; запретить
  создание без поля можно ограничением (ниже).

## Ограничения (restrictions)

`GET/POST /spaces/{id}/restrictions` — в документации нет, формат снят с
правил из интерфейса:

```json
{
  "name": "…", "type": "on_action", "status": "active", "error_text": "…",
  "restrictions": [{ "type": "movement | creation", "operator": "eq", "created": "<ISO>",
    "data": { "path": { "spaceId": 1, "boardId": 2, "columnId": 3 }, "pathType": "concrete" } }],
  "conditions": [
    { "type": "prevCardPath", "operator": "eq", "created": "<ISO>",
      "data": { "comparator": "or", "paths": [{ "path": { "…": "…" }, "pathType": "concrete" }] } },
    { "type": "cardProperty", "operator": "eq", "created": "<ISO>",
      "data": { "comparator": "or", "properties": [{ "propertyKey": "id_<поле>", "propertyType": "string", "comparator": "noSet", "value": null }] } },
    { "type": "cardType", "operator": "eq", "created": "<ISO>", "data": { "typeIds": [1] } },
    { "type": "childCardsDone", "operator": "eq", "created": "<ISO>", "data": {} }
  ]
}
```

- `created` у условий обязателен (400 «should have required property
  'created'»).
- «Предыдущий путь» (`prevCardPath`) — колонка, *из* которой переносят.
- Нарушение — 400 с `error_text`; ограничения действуют и на API.
- Создание карточки сразу в конечной колонке ограничения на перенос не
  останавливают.
- Лимит — 15 на компанию на тарифах «Стандарт»/«Бизнес» без модуля
  «Ограничения».

## Пространства и участники

- «Папка» — это пространство с вложенными пространствами: у вложенного
  `parent_entity_uid` = `uid` родителя. Отдельного типа «папка» для
  пространств API не показывает (`GET /tree-entities` — `entity_type: space`).
- Вложить сразу: `POST /spaces {title, parent_entity_uid}`. Перенести и
  переименовать существующее: `PATCH /spaces/{id} {title, parent_entity_uid}` —
  id пространства и досок не меняются, ограничения доски продолжают
  действовать.
- Дорожка: `POST /boards/{id}/lanes {title, sort_order}`; новая доска приходит
  с одной дорожкой «Default Lane». Карточку между дорожками переносит
  `PATCH /cards/{id} {lane_id}` — и вместе с `column_id` одним запросом.
- `GET /spaces` отдаёт у пространства `parent_entity_uid` и `boards` (id досок).
- `DELETE /spaces/{id}` удаляет пространство с досками и карточками, но
  отказывает, если внутри есть дерево документов («Space has child tree
  entities») — сначала удалить или перенести папки документов
  (`DELETE /document-groups/{uid}`).
- Участник: `POST /spaces/{id}/users {email}` — по почте, не по id (иначе
  400 «Invalid email»). Роль в этом запросе игнорируется — выдаётся роль по
  умолчанию; сменить — `PATCH /spaces/{id}/users/{user} {role_id: <uid роли>}`
  (`role_ids` молча игнорируется). Роли — `GET /tree-entity-roles`.
- Тариф и доступные возможности — `GET /companies/current` (`features`,
  `current_client_tariff`).
- Доска: `PATCH /boards/{id}` отвечает 405 — правка идёт через пространство:
  `PATCH /spaces/{space}/boards/{id} {description, default_card_type_id}`.
  Описание сохраняется строкой как есть (markdown не меняется). Командой
  `kaiten` описание доски и тип по умолчанию не читаются: тип карточки она
  задаёт сама.

## Документы

Проверено живьём 15.10.2026.

- Дерево: `GET /tree-entities?parent_entity_uid=<uid>&levels_count=1|2`
  (глубже 2 — 400), узлы `entity_type: space | document_group | document`;
  полное дерево — рекурсивно по `has_children`.
- Папка: `POST /document-groups {title, sort_order, parent_entity_uid}`;
  документ: `POST /documents {title, sort_order, parent_entity_uid}`.
  `sort_order` обязателен и больше нуля. Документ без родителя ложится в
  корень компании.
- `POST` молча выбрасывает содержимое — документ всегда пустой; текст —
  вторым запросом `PATCH /documents/{uid} {data: <ProseMirror JSON>}`,
  только целиком. `GET` отдаёт `data` строкой с JSON.
- Блокировки нет: `version`/`updated` в `PATCH` игнорируются, последняя
  запись выигрывает. Правки через API не создают контрольных точек истории.
- Документ, созданный через API, получает схему v1: абзацы, заголовки,
  списки, таблицы, код, цитаты; чек-листы, ссылки на карточки, вкладки — 500.
- Выдача доступа к документу по почте (`POST /documents/{uid}/users {email}`)
  с незнакомым адресом **заводит пользователя компании** и шлёт приглашение.
- `DELETE` безвозвратен; документ или папку с вложенными узлами удалить
  нельзя. `clone_uid` кладёт копию рядом с источником, игнорируя родителя.
- Поиск: по заголовку — `GET /documents?query=`, по тексту —
  `GET /documents?version=2&query=`.
- Документ, созданный в интерфейсе (новая схема, с чек-листом), `PATCH`
  целиком принимает: узлы человека возвращаются без изменений (16.10.2026).
- Адрес документа в интерфейсе — `https://<домен>/documents/d/<uid>`,
  карточки — `https://<домен>/space/<пространство>/boards/card/<id>`.
- Внешняя ссылка карточки: `POST /cards/{id}/external-links {url, description}`,
  правка — `PATCH /cards/{id}/external-links/{link}`; в карточке — `external_links`.

## Автоматизации

Автоматизация без условия на исходную колонку срабатывает на любой перенос:
такая конструкция возвращала карточки в исходную колонку раз в минуту. Для
графа переходов надёжнее ограничения.

## Вебхуки

Список исходящих событий, подпись и повторы не опубликованы — поэтому
синхронизация построена на сверке, а не на событиях.
