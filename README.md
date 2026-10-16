# kaiten-tracker

Задачи проекта — файлами в git, доска — в [Kaiten](https://kaiten.ru). Команда
`kaiten` ведёт задачи из репозитория кода: найти, прочитать, взять в работу,
отметить пункты, сдать на ревью. Она пишет изменение сразу локально, а в общий
репозиторий задач и в карточку Kaiten отправляет в фоне. Сделано в первую
очередь для ИИ-агентов (Claude Code и подобных): скилл `skills/kaiten` учит
агента работать через задачи, а команды отвечают так, чтобы агенту не нужно
было читать код инструмента.

## Как устроено

- **Репозиторий задач** — по одному на проект. Задача — файл
  `active/<slug>.md` (закрытые — `archive/YYYY-MM/`), журнал —
  `<slug>.log.md`, вложения — `attachments/<slug>/`. В корне — `kaiten.json`:
  всё о проекте (доска Kaiten, поля, репозитории кода, команды, люди).
- **Репозиторий кода** подключается файлом `.kaiten` в корне: адрес репозитория
  задач и какой из репозиториев проекта этот.
- **Хранилище на машине** — git без рабочей копии (`%LOCALAPPDATA%\kaiten`,
  `~/.local/share/kaiten`, `~/Library/Application Support/kaiten`). Файлов
  задач, которые можно поправить в обход команд, на диске нет.
- **Kaiten** — карточка на задачу. Владельцы полей разделены: постановка,
  «Суть» и пункты — в файле; колонка, приоритет, сроки и исполнитель — в Kaiten.
  Статусы работы (`start`/`review`/`done`) команды ставят сначала в карточке,
  чтобы действовали ограничения доски.

Синхронизация — сверка файлов и карточек при записи и при `kaiten pull`, без
вебхуков: потерянное событие сверка не пропускает. Своего сервера нет.

## Установка

На машине разработчика, один раз:

```bash
git clone <адрес kaiten-tracker> && cd kaiten-tracker
node scripts/install.mjs      # Node.js и git → зависимости → команда kaiten в PATH → настройки с личным входом в Kaiten
```

Скрипт спрашивает домен и личный токен Kaiten (ввод токена не показывается;
без вопросов — `--domain` и переменная `KAITEN_TOKEN`) и пишет
`kaiten.settings.json` (в `.gitignore`). `--no-kaiten` — без входа: задачи
ведутся, карточки не обновляются. `--check` — только показать, что сделано.
Повторный запуск ничего не перезаписывает. Кто вы в задачах, определяется по
почте git из реестра людей проекта; `--person` — если почта другая.

Linux: если глобальная папка npm принадлежит root, `npm link` падает с
`EACCES` — скрипт подскажет завести свою (`npm config set prefix
~/.npm-global` и `~/.npm-global/bin` в PATH). Проверено на Windows и в Docker
(`node:24-bookworm-slim`); на macOS не запускалось.

Git должен уметь войти в GitHub по тому адресу задач, что записан в проекте
(обычно HTTPS). Если на машине есть только SSH-ключ, а логина для HTTPS нет,
`kaiten pull` и `kaiten doctor` скажут, что не может войти git на машине, — это не
отказ в доступе к проекту. Исправить: войти для HTTPS (`gh auth login`) или
перенаправить HTTPS на SSH:

```bash
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

Проверка — из подключённого репозитория кода:

```bash
kaiten doctor            # машина, репозиторий, задачи: что готово и что исправить
kaiten doctor --offline  # без проверок, которым нужна связь
```

## Новый проект

1. Репозиторий задач с `kaiten.json` в корне:

   ```json
   {
     "project": "acme",
     "title": "Acme",
     "kaiten": {
       "space": "Acme (разработка)", "board": "Задачи", "repoField": "Репозиторий Acme",
       "folder": "Acme", "departments": ["marketing", "hr", "sales", "finance", "support", "admin"],
       "archiveLane": "Архив"
     },
     "tasksRepo": { "url": "https://github.com/acme-org/acme-tasks.git" },
     "repos": [
       { "name": "acme-app", "label": "Acme-app", "lane": "Приложение" },
       { "name": "acme-site", "label": "Acme-site", "lane": "Сайт" }
     ],
     "teams": ["Разработка", "Дизайн"],
     "defaultTeam": "Разработка",
     "people": { "people": { "alice": { "name": "Алиса" } }, "emails": { "alice@example.com": "alice" } }
   }
   ```

2. Структура в Kaiten — пространство, доска с колонкой на статус, типы
   карточек, поля «Приоритет», «Команда», «Репозиторий <Проект>», «Суть»:

   ```bash
   npm run setup -- --tasks <рабочая копия репозитория задач>            # план
   npm run setup -- --tasks <рабочая копия репозитория задач> --apply    # создать и записать id в kaiten.json
   ```

   Закоммитьте и отправьте `kaiten.json`. Типы и поля компании заводит только
   администратор компании Kaiten.

   Необязательное в `kaiten`: `folder` — пространство-«папка», в которое
   кладётся пространство разработки (уже заведённое по прошлому `setup`
   переименовывается и переносится, доска и карточки остаются);
   `departments` — пространства отделов в папке из шаблонов (`marketing`,
   `hr`, `sales`, `finance`, `support`, `admin`), заведённые план больше не
   трогает. `repos[].lane` — дорожка продукта на доске, `archiveLane` —
   дорожка, куда синхронизация убирает карточки, закрытые больше месяца
   назад; продукт по-прежнему хранит поле «Репозиторий». Дорожка — только
   раскладка: ручной перенос между дорожками синхронизация не откатывает.

3. Подключить репозиторий кода — `.kaiten`, копия скилла и блок правил в
   `CLAUDE.md` (или `AGENTS.md`):

   ```bash
   npm run connect-repo -- <папка репозитория кода> --tasks <репозиторий задач> --repo acme-app           # план
   npm run connect-repo -- <папка репозитория кода> --tasks <репозиторий задач> --repo acme-app --apply   # записать
   ```

   `--push none|branch|pr` — что агент делает с веткой перед ревью (по
   умолчанию `branch`: отправить ветку, PR открывает человек). Скрипт не
   коммитит. Команды `kaiten` для подключения нет намеренно: агент не должен
   подключать репозиторий сам.

4. Карточки для задач, которые уже есть в файлах:

   ```bash
   npm run kaiten-sync -- --tasks <адрес репозитория задач> --first-load              # сухой прогон
   npm run kaiten-sync -- --tasks <адрес репозитория задач> --first-load --apply      # создать
   ```

5. Проверка формата в Actions репозитория задач — скопируйте
   `templates/tasks-repo/.github/workflows/tasks-lint.yml` и задайте
   `vars.KAITEN_TRACKER_REPO`.

## Команда `kaiten`

Чтение — без сети; запись — сразу локально, в общий репозиторий и Kaiten — в
фоне. Подробности — `kaiten <команда> --help`.

```bash
kaiten list                   # открытые задачи продукта текущего репозитория
kaiten show PRJ-123           # задача целиком, её эпик и соседние; по частям: --outline, --section, --todo, --log N
kaiten search таймаут вебхук  # по задачам и текстовым вложениям; a|b — варианты, --regex, --lines
kaiten files PRJ-123          # вложения задачи
kaiten pull                   # свежие задачи и отправка своих изменений
kaiten new "Починить…" --type bug --slug fix-… --summary "…" --stdin <<'EOF' … EOF   # с постановкой; [--agent] [--from PRJ-123] [--no-criteria "почему"]
kaiten check PRJ-123 "тест на таймаут"   # отметить пункты
kaiten log PRJ-123 "что сделано"         # запись в журнал
kaiten attach PRJ-123 report.md          # приложить файл
kaiten block PRJ-123 --reason "…"        # заблокирована
kaiten cancel PRJ-123 --reason "…"       # отменить (только не начатую)
kaiten edit PRJ-123                      # правка текста; --stdin — для агента
kaiten start PRJ-123                     # «В работе» и ветка feature/<ключ>-<имя>
kaiten review PRJ-123 [--note "PR #45"]  # на ревью: нужны отмеченные критерии и запись о работе в журнале
kaiten done PRJ-123 [--note "…"]         # влито — «Сделано», задача в архив
```

Настройки — `kaiten.settings.json` в папке инструмента (образец —
`kaiten.settings.example.json`): личный вход в Kaiten, включение обновления
карточек (`sync.kaiten`), копия задач для чтения людьми (`localCopy`).
Пробные прогоны — с `KAITEN_STORE`, `KAITEN_SETTINGS` и `KAITEN_CONFIG`
(путь к `kaiten.json`), чтобы не трогать настоящее хранилище и настройки.

## Формат задачи

Шапка YAML, тело — markdown. Обязательные поля: `title` (с глагола),
`summary` («Суть»: 1–3 предложения без терминов кода), `type` (`epic`,
`story`, `tech`, `bug`, `spike`), `repo` (у эпика необязателен). Остальное
ставят команды: `id` (ULID), `status`, `created*`, `updated`, `tracker`
(ключ карточки), `branch`, `content_hash`. Тело — разделы по типу:

| Тип | Разделы |
|---|---|
| story, tech | Зачем · Что сделать · Критерии готовности · Шаги |
| bug | Что происходит · Как воспроизвести · Как должно быть · Критерии |
| epic | Цель · Критерии-результаты (работа эпика — его задачи) |
| spike | Вопрос · Как ищем ответ · Ответ |

Пункты `- [ ]` раздела уходят в Kaiten чек-листом «Агент · <раздел>»: чек-лист
ведёт файл — после правки задачи в карточке те же пункты в том же порядке,
лишние удаляются; чек-листы без префикса ведут люди. Линтер —
`npm run tasks:lint -- <папка репозитория задач>`.

## Скрипты владельца

Без `--apply`/`--write` только читают и показывают план. Вход в Kaiten —
`KAITEN_DOMAIN`/`KAITEN_TOKEN` (`.env`, образец — `.env.example`) или
настройки.

| Скрипт | Что делает |
|---|---|
| `npm run setup` | структура проекта в Kaiten, id — в `kaiten.json` |
| `npm run kaiten-sync` | синхронизация с Kaiten: сухой прогон с подробностями, `--apply`, `--first-load`, `--only`, `--resend` (описание и чек-листы заново) |
| `npm run connect-repo` | подключение репозитория кода |
| `npm run tasks:lint` | линтер репозитория задач |
| `npm run backup -- --out <папка>` | снимок аккаунта Kaiten файлами; шаблон ночного workflow — `templates/kaiten-backup/` |
| `npm run inspect` | снимок структуры аккаунта |
| `npm run normalize` | дозаполнить постановку открытых задач до формата `kaiten new` с помощью `claude -p`; ответ модели проверяется механически |
| `npm run convert` | разовый перенос задач из папок `tasks/` репозиториев кода в репозиторий задач |
| `npm run import` | заливка карточек из папок `tasks/` (до репозитория задач) |
| `npm run yonote` | разовая выгрузка базы знаний yonote в `tmp/` |

## Что где

| Файл | Ответственность |
|---|---|
| `src/core/schema.ts`, `src/core/document.ts` | Формат задачи: поля, владельцы полей, разбор и запись, `content_hash` |
| `src/core/skeleton.ts`, `src/core/lint.ts` | Разделы по типу, проверка постановки новой задачи, линтер |
| `src/core/tasks-index.ts` | Задачи в памяти: поиск по ключу, эпики, фильтры, поиск по словам |
| `src/core/task-ops.ts` | Операции записи (чистая часть): new, check, log, block, cancel, edit, move |
| `src/core/kaiten-sync-plan.ts`, `src/core/kaiten-adopt.ts` | План синхронизации с Kaiten; карточки из интерфейса → задачи |
| `src/config.ts`, `src/owner-project.ts` | `kaiten.json` и откуда его берут скрипты владельца |
| `src/task-store.ts`, `src/store-write.ts` | Хранилище без рабочей копии, журнал операций, отправка, замки |
| `src/kaiten.ts`, `src/kaiten-cli.ts`, `src/kaiten-write.ts`, `src/kaiten-start.ts`, `src/kaiten-format.ts`, `src/kaiten-doctor.ts` | Команда `kaiten` |
| `src/kaiten-context.ts` | `.kaiten` и `kaiten.settings.json` |
| `src/kaiten-client.ts` | HTTP-клиент Kaiten: пагинация, лимиты, повторы |
| `src/kaiten-sync.ts`, `src/kaiten-sync-cli.ts` | Выполнение плана синхронизации |
| `src/setup*.ts`, `src/connect-repo.ts`, `src/core/repo-connect.ts` | Структура в Kaiten, подключение репозитория кода |
| `src/normalize-tasks.ts`, `src/convert*`, `src/import.ts`, `src/plan.ts`, `src/task-source.ts`, `src/numbered-source.ts`, `src/yonote*` | Инструменты переезда |
| `skills/kaiten/SKILL.md` | Скилл агента |
| `scripts/install.mjs` | Установка на машину |
| `docs/kaiten-api.md` | Как ведёт себя API Kaiten — проверено на живом аккаунте |

## Разработка

```bash
npm install
npm run typecheck && npm test   # сети в тестах нет: Kaiten — поддельный fetch
```

Стек: TypeScript, tsx, zod, vitest. Сообщения команд и комментарии — по-русски.
