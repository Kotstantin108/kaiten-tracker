/**
 * Команды записи CLI `kaiten`: `new`, `check`, `log`, `attach`, `detach`, `block`, `cancel`,
 * `review`, `done`, `edit` (`start` — в `kaiten-start.ts`). Каждая: проверить задачу → записать операцию локально (журнал +
 * коммит, `store-write.ts`) → обновить копию для чтения → отправить общим в
 * фоне. Агент не ждёт сеть; что не применилось при отправке, скажет
 * следующая команда.
 *
 * Kaiten обновляется при включённой синхронизации (`sync.kaiten`): текст —
 * в фоне, статус — сразу и сначала в карточке (`moveCardFirst`; Kaiten недоступен — в очередь задачи): отказ доски
 * останавливает команду.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { domainProblem, domainsOf, juniorSetting, testPlanRequired, visualFields } from './config.js';
import { contentHash, parseTaskDocument, serializeTaskDocument } from './core/document.js';
import { SLUG_RE } from './core/lint.js';
import { JUNIOR_TYPES, juniorMissingText, juniorReadiness, withJuniorTemplate } from './core/junior.js';
import { criteriaText, newBodyProblems, newBodyTemplate, SKELETONS, testPlanApplies, withCriteriaWaiver, withTestPlanTemplate, withTestPlanWaiver } from './core/skeleton.js';
import { TASK_TYPES, type TaskType, type VisualAnswer } from './core/schema.js';
import { ATTACHMENT_MAX_BYTES, attachmentNameProblem, BLOCKABLE, CANCELLABLE, hasWorkNote, matchItem, moveProblem, newTaskText, slugify, uniqueSlug, writesLog, type Op } from './core/task-ops.js';
import { refOf, type TaskRecord } from './core/tasks-index.js';
import { ulid } from './core/ulid.js';
import { detachTarget, isVisualAttachment, VISUAL_MAX_PAIRS, visualApplies, visualAttachName, visualAttachProblem, visualDecision, visualLimitProblem } from './core/visual.js';
import {
  attachmentRefs,
  currentPerson,
  findTask,
  loadTasks,
  cardNotMovedNote,
  queuedOf,
  type MoveStep,
  moveCardFirst,
  parse,
  printNotices,
  refreshLocalCopy,
  resolveContext,
  startSend,
  stringFlag,
  TASK_REF_HELP,
  today,
  UsageError,
  type Context,
} from './kaiten-cli.js';
import { progressLine } from './kaiten-format.js';
import { git } from './kaiten-start.js';
import { reviewGateNotes } from './kaiten-verify.js';
import { recordOp, storeBlob } from './store-write.js';
import type { StoreEntry } from './task-store.js';

export const WRITE_HELP: Record<string, string> = {
  new: `kaiten new "<заголовок>" — завести задачу.

Задача попадает во «Входящие» без приоритета: его ставят при разборе.
Задачу заводят, когда об этом попросил человек. Дефект, который вы сами
заметили по ходу другой работы, — не сюда: kaiten found.
Заголовок — с глагола («Починить…», «Перенести…»). «Суть» — 1–3 предложения
для фаундера без терминов кода. Постановка — сразу, через --stdin: что
видели и знаете сейчас, потом не вспомнит никто.

Разделы постановки по типу (обязательные; «Шаги» — по желанию):
  story, tech  Зачем · Что сделать · Критерии готовности
  bug          Что происходит · Как воспроизвести · Как должно быть · Критерии
  epic         Цель · Критерии-результаты (работа эпика — его задачи)
  spike        Вопрос · Как ищем ответ («Ответ» — при закрытии)
Критерии — пункты «- [ ] …», по которым проверят, что задача сделана. Нельзя
их назвать — --no-criteria с причиной; работа «разобраться» — это spike.
Если проект отмечает задачи для младших разработчиков, у story, tech, bug
перед критериями ещё «Продуктовые решения», «Изменения в БД», «Сценарии n8n»
(шаблон — в отказе команды без --stdin). Они необязательны: «Нет» — только
проверив по коду; иначе — все пункты; не знаете — оставьте раздел пустым.
Если проект просит план проверки, у story перед «Шаги» обязателен раздел «Как
проверить»: какие интеграционные тесты добавить или изменить и как проверить
результат как чёрный ящик, не читая код. Проверять нечего — --no-test-plan с
причиной.
Если проект делит задачи на домены, --domain называет домен задачи: по нему
на ревью решают, как читать изменения. Список доменов — в отказе команды на
неизвестное имя.

Флаги:
  --type <тип>        обязательно: ${TASK_TYPES.join(', ')}
  --summary <текст>   обязательно: «Суть»
  --stdin             обязательно: постановка — из стандартного ввода
  --slug <имя>        короткое имя по-английски через дефис; обязательно, если
                      в заголовке не латиница
  --epic <задача>     эпик, в который входит задача
  --from <задача>     задача, по ходу которой нашлась эта работа (в «Связано»)
  --no-criteria <почему>  критериев нет — и почему
  --no-test-plan <почему> проверять нечего — и почему (story, если проект
                      просит «Как проверить»)
  --domain <имя>      домен задачи, если проект их ведёт
  --agent             задачу заводит агент

Пример:
  kaiten new "Починить порядок даты в отчёте" --type bug --agent \\
    --slug fix-report-date --from PRJ-123 \\
    --summary "Дата в отчёте читается как месяц-день-год, 3 октября выглядит как 10/3." --stdin <<'EOF'
  ## Что происходит

  В заголовке отчёта дата в порядке месяц/день/год.

  ## Как воспроизвести

  1. Сформировать отчёт 3 октября — в заголовке 10/3/2026.

  ## Как должно быть

  День.месяц.год: 03.10.2026.

  ## Критерии

  - [ ] Дата в заголовке отчёта — день.месяц.год
  - [ ] Есть тест на дату с однозначным днём
  EOF
`,
  check: `kaiten check <задача> <пункт>... — отметить пункты задачи.

Пункт — его текст или слова, по которым он находится однозначно; обратные
кавычки в тексте пункта можно не писать. Можно несколько пунктов за раз:
однозначные отмечаются, про остальные команда говорит, что не так, и
завершается с ошибкой. Команда называет отмеченные пункты и счёт по разделам.
${TASK_REF_HELP}

Флаги:
  --off               снять отметку

Пример:
  kaiten check PRJ-123 'тест на таймаут' 'ретраи'
`,
  attach: `kaiten attach <задача> <файл> — приложить файл к задаче.

Отчёт, передача дел, схема, данные — всё, что относится к задаче, но не
постановка. Файл с таким именем у задачи заменяется. Вложения и журнал
задачи видны человеку файлами в карточке Kaiten — переносить текст
вложения в постановку не нужно. Читать вложения — kaiten files <задача>.
Скриншоты «Было / Стало» (было-<экран>.png, стало-<экран>.png; png или jpg,
до 1 МБ, не больше ${VISUAL_MAX_PAIRS} экранов на задачу) сами ложатся в папку
было-стало/. Убрать лишний — kaiten detach.
${TASK_REF_HELP}

Флаги:
  --as <имя>          имя вложения (по умолчанию — имя файла)
  --stdin             содержимое — из стандартного ввода; тогда второй
                      аргумент — имя вложения

Примеры:
  kaiten attach PRJ-123 report.pdf
  kaiten attach PRJ-123 tmp/стало-главная-телефон.png
  kaiten attach PRJ-123 tmp/notes.md --as HANDOFF.md
  kaiten attach PRJ-123 HANDOFF.md --stdin <<'EOF'
  …текст…
  EOF
`,
  detach: `kaiten detach <задача> <картинка>... — убрать скриншоты «Было / Стало» из задачи.

Лишние экраны (их не больше ${VISUAL_MAX_PAIRS} на задачу), повторы, не те файлы
в папке было-стало/, картинки было-…/стало-…, приложенные мимо папки. Имя —
как в kaiten files <задача>: было-x.png — сначала файл с этим именем вне папки,
а если его нет — из было-стало/; было-стало/было-x.png — только из папки.
Можно несколько за раз; экран — это пара было-<экран>.png и стало-<экран>.png.
Из карточки Kaiten вслед за задачей уходят картинки папки было-стало/;
картинка мимо папки там остаётся — её, если мешает, убирают в Kaiten.
${TASK_REF_HELP}

Пример:
  kaiten detach PRJ-123 было-форма-телефон.png стало-форма-телефон.png
`,
  log: `kaiten log <задача> "<текст>" — запись в журнал задачи.

Что сделано, что выяснилось, что мешает. Первая строка — заголовок записи.

Флаги:
  --stdin             текст — из стандартного ввода

Пример:
  kaiten log PRJ-123 "Воспроизвёл на staging: причина в ретраях"
`,
  block: `kaiten block <задача> --reason "<что мешает>" — задача заблокирована.

Флаги:
  --reason <текст>    обязательно: что блокирует задачу

Пример:
  kaiten block PRJ-123 --reason "ждём доступ к платёжному кабинету"
`,
  cancel: `kaiten cancel <задача> --reason "<почему>" — отменить задачу.

Отменить можно задачу, которая ещё не в работе: во «Входящих», «Бэклоге»
или «Готово к работе». Удалить задачу нельзя — только отменить.

Флаги:
  --reason <текст>    обязательно: почему задача не нужна

Пример:
  kaiten cancel PRJ-130 --reason "дубль PRJ-123"
`,
  review: `kaiten review <задача> — работа готова, задача на ревью.

Из «В работе», когда критерии задачи отмечены и в журнале есть запись о
работе (kaiten log: что сделано, почему так, чем проверено). Ветку и
последний коммит текущего репозитория команда пишет в журнал сама. Эпик так
не закрывают: его закрывают в Kaiten, когда закрыты его задачи.

Если проект просит «Было / Стало», у story, tech, bug нужен ответ: скриншоты
экрана до и после (kaiten attach PRJ-123 было-<экран>.png и стало-<экран>.png)
или --no-visual с причиной, если на экране ничего не меняется.

Флаги:
  --note <текст>      что смотреть на ревью (ветка, коммит, PR) — в журнал
  --unchecked <текст> почему часть критериев осталась без отметки — в журнал;
                      без этого флага задача с неотмеченными критериями на
                      ревью не уходит
  --no-visual <текст> почему на экране ничего не меняется — вместо скриншотов
  --no-ingest <текст> почему документация не меняется — вместо её правки

Если проект требует проверок перед ревью, у story, tech, bug нужен их успешный
прогон на текущем коммите ветки: kaiten verify PRJ-123. Команда сдаётся из
репозитория задачи, с её ветки, без незакоммиченных изменений; новый коммит
после прогона — и verify нужно повторить.

Если проект требует документации, в изменениях ветки должна быть её правка
(страница модуля, который меняли) — или --no-ingest с причиной.

Примеры:
  kaiten review PRJ-123 --note "PR #45"
  kaiten review PRJ-124 --no-visual "только сценарий n8n"
  kaiten review PRJ-125 --no-ingest "правка опечатки в тексте кнопки"
`,
  done: `kaiten done <задача> — задача сделана (влито в прод).

Из «Ревью». Задача уходит в архив, в «Сделано». «Было / Стало» — как у
kaiten review, если на ревью ответа не дали.

Флаги:
  --note <текст>      что влито и куда — в журнал
  --no-visual <текст> почему на экране ничего не меняется — вместо скриншотов

Пример:
  kaiten done PRJ-123 --note "влито в main, выкатано"
`,
  edit: `kaiten edit <задача> — поправить текст задачи.

Открывает задачу в вашем редакторе; после сохранения задача проверяется и
записывается. Меняются заголовок, «Суть», постановка, репозиторий, эпик,
связи и домен (строка domain: в шапке, если проект делит задачи на домены);
статус, приоритет, исполнитель и сроки меняются в Kaiten.

Флаги:
  --stdin             новый текст задачи целиком — из стандартного ввода
                      (текущий: kaiten show <задача> --raw)

Примеры:
  kaiten edit PRJ-123
  kaiten edit PRJ-123 --stdin <<'EOF'
  ---
  …весь текст задачи из kaiten show PRJ-123 --raw, с правками…
  EOF
`,
};

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

/** Записать операцию и сказать, что получилось. Запись журнала без автора — отказ до записи. */
export async function commit(ctx: Context, op: Op, what: string): Promise<void> {
  const by = writesLog(op) ? currentPerson(ctx.loaded.people) : undefined;
  const result = recordOp(ctx.store, op, what, today(), { by });
  if ('error' in result) throw new UsageError(`Не записано: ${result.error}`, 1);
  const first = result.summary.charAt(0).toUpperCase() + result.summary.slice(1);
  console.log(result.changed ? `${first}.` : `${first} — менять нечего.`);
  for (const w of result.warnings) console.log(`  подсказка: ${w}`);
  if (!result.changed) return;
  refreshLocalCopy(ctx);
  await startSend(ctx);
}

function begin(): Context {
  const ctx = resolveContext();
  printNotices(ctx);
  return ctx;
}

function taskArg(positionals: string[], command: string): string {
  if (positionals.length === 0) throw new UsageError(`Укажите задачу: kaiten ${command} PRJ-123`);
  return positionals[0];
}

async function newTask(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    'new',
    args,
    {
      type: { type: 'string' },
      summary: { type: 'string' },
      epic: { type: 'string' },
      from: { type: 'string' },
      slug: { type: 'string' },
      agent: { type: 'boolean' },
      stdin: { type: 'boolean' },
      'no-criteria': { type: 'string' },
      'no-test-plan': { type: 'string' },
      domain: { type: 'string' },
    },
    1,
  );
  const title = positionals[0]?.trim();
  if (!title) throw new UsageError('Укажите заголовок: kaiten new "Починить…" --type bug --summary "…" --stdin');
  const type = stringFlag(values, 'type');
  if (!type || !(TASK_TYPES as readonly string[]).includes(type)) throw new UsageError(`--type: укажите тип задачи: ${TASK_TYPES.join(', ')}`);
  const taskType = type as TaskType;
  const summary = stringFlag(values, 'summary')?.trim();
  if (!summary) throw new UsageError('--summary: без «Сути» задачу не завести — 1–3 предложения для фаундера.');
  const waiver = stringFlag(values, 'no-criteria')?.trim();
  if (waiver !== undefined && !waiver) throw new UsageError('--no-criteria: напишите, почему у задачи нет критериев.');
  if (waiver && !SKELETONS[taskType].criteria) throw new UsageError(`--no-criteria: у задачи типа ${type} нет раздела критериев.`);
  const planWaiver = stringFlag(values, 'no-test-plan')?.trim();
  if (planWaiver !== undefined && !planWaiver) throw new UsageError('--no-test-plan: напишите, почему у задачи нечего проверять.');
  if (planWaiver && !testPlanApplies(taskType)) throw new UsageError(`--no-test-plan: раздел «Как проверить» — только у story, у задачи типа ${type} его нет.`);

  const ctx = begin();
  // Домен — по списку проекта: неизвестный отклоняем до всего остального, со списком допустимых.
  const domain = stringFlag(values, 'domain')?.trim();
  if (domain !== undefined) {
    const problem = domain ? domainProblem(ctx.loaded.project, domain) : 'назовите домен задачи';
    if (problem) throw new UsageError(`--domain: ${problem}.`);
  }
  // «Как проверить» — только в проекте, который просит план проверки, и только у story.
  const testPlan = testPlanRequired(ctx.loaded.project) && testPlanApplies(taskType);
  // Разделы продукта, БД и n8n — в шаблоне, только если проект ведёт признак «Можно младшему».
  const juniorState = juniorSetting(ctx.loaded.project);
  const junior = juniorState.state !== 'off' && JUNIOR_TYPES.includes(taskType);

  // Всё, чего не хватает, — одним отказом и готовой командой с флагами самого вызова: агент исполняет отказы, а не подсказки.
  const problems: string[] = [];
  // Имя задачи из кириллического заголовка вышло бы транслитом (pochinit-format-daty…) — его просим придумать.
  const slugFlag = stringFlag(values, 'slug')?.trim();
  if (slugFlag === undefined && /[^\x20-\x7e]/.test(title)) problems.push('--slug: придумайте задаче короткое имя по-английски латиницей через дефис');
  // Постановка — сразу: тот, кто заводит задачу, знает контекст сейчас, а потом его не вспомнит никто.
  let body = '';
  if (!values.stdin) problems.push('--stdin: задача заводится с постановкой — заполните разделы');
  else {
    body = readStdin();
    if (waiver) body = withCriteriaWaiver(taskType, body, waiver);
    if (planWaiver && testPlan) body = withTestPlanWaiver(taskType, body, planWaiver);
    problems.push(...newBodyProblems(taskType, body, { testPlan }));
  }
  if (problems.length > 0) {
    const quote = (s: string): string => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
    const flags = [
      `--type ${type}`,
      values.agent ? '--agent' : '',
      `--slug ${slugFlag ?? (type === 'bug' ? 'fix-…' : 'add-…')}`,
      ...(['epic', 'from', 'domain', 'no-criteria', 'no-test-plan'] as const).map((f) => (stringFlag(values, f) ? `--${f} ${quote(stringFlag(values, f) ?? '')}` : '')),
      `--summary ${quote(summary)}`,
    ].filter(Boolean);
    const base = testPlan ? withTestPlanTemplate(taskType, newBodyTemplate(taskType)) : newBodyTemplate(taskType);
    const filled = junior ? withJuniorTemplate(taskType, base) : base;
    const juniorNote = junior
      ? '\nПродукт, БД, n8n — для младших разработчиков: «Нет» — только проверив по коду; иначе все пункты; не знаете — оставьте раздел пустым.'
      : '';
    throw new UsageError(
      `Не записано:${problems.map((p) => `\n  - ${p}`).join('')}\n\n` +
        `Так задача заводится (разделы — для типа ${type}; «Шаги» и свои разделы можно добавить):${juniorNote}\n\n` +
        `kaiten new ${quote(title)} ${flags.join(' ')} --stdin <<'EOF'\n${filled}\nEOF`,
      1,
    );
  }

  const { index } = loadTasks(ctx);
  const fromRef = stringFlag(values, 'from');
  const related = fromRef ? [findTask(index, fromRef).slug] : undefined;
  let epic: string | undefined;
  const epicRef = stringFlag(values, 'epic');
  if (epicRef) {
    if (type === 'epic') throw new UsageError('--epic: у эпика не бывает эпика — уровней два.');
    const found = findTask(index, epicRef);
    if (found.fm.type !== 'epic') throw new UsageError(`--epic: ${epicRef} — не эпик, а ${found.fm.type}.`);
    epic = found.fm.tracker ?? found.fm.id;
  }

  const taken = new Set(index.tasks.map((t) => t.slug));
  for (const p of index.problems) taken.add(p.path.split('/').at(-1)?.replace(/\.md$/, '') ?? '');
  const wanted = stringFlag(values, 'slug')?.trim() ?? slugify(title);
  if (!wanted || !SLUG_RE.test(wanted)) throw new UsageError('--slug: короткое имя латиницей через дефис, например fix-webhook-retry.');
  if (stringFlag(values, 'slug') && taken.has(wanted)) throw new UsageError(`--slug: задача ${wanted} уже есть — выберите другое имя.`);
  const slug = uniqueSlug(wanted, taken);

  const text = newTaskText(
    {
      id: ulid(),
      slug,
      title,
      summary,
      type: taskType,
      repo: type === 'epic' ? undefined : ctx.currentRepo,
      epic,
      related,
      domain,
      createdBy: currentPerson(ctx.loaded.people),
      createdVia: values.agent ? 'agent' : 'human',
      body,
    },
    today(),
  );
  if (typeof text !== 'string') throw new UsageError(`Не записано: ${text.error}`, 1);
  await commit(ctx, { kind: 'new', path: `active/${slug}.md`, text }, `новая задача ${slug}`);
  console.log(`Открыть: kaiten show ${slug}`);
  if (junior) {
    // Во «Входящих» признака нет — его получает разобранная задача; здесь — каким он будет после разбора.
    const readiness = juniorReadiness({ type: taskType, status: 'backlog', created: today(), revised: today() }, body, { today: today(), maxAgeDays: juniorState.maxAgeDays });
    if (readiness) console.log(readiness.ok ? 'Младшему после разбора: да.' : `Младшему после разбора: нет — не хватает: ${juniorMissingText(readiness.missing)}.`);
  }
}

async function check(args: string[]): Promise<void> {
  const { values, positionals } = parse('check', args, { off: { type: 'boolean' } });
  const ref = taskArg(positionals, 'check');
  const queries = positionals.slice(1);
  if (queries.length === 0) throw new UsageError('Укажите пункт: kaiten check PRJ-123 "тест на таймаут"');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  // Каждая фраза — сама по себе: однозначные отмечаются, спорные называются. Раньше одна спорная
  // фраза отклоняла всю команду, и агент уходил дальше с нулём отметок (испытание 30.09).
  const items: string[] = [];
  const missed: string[] = [];
  for (const q of queries) {
    const hit = matchItem(task.body, q);
    if ('error' in hit) missed.push(q);
    else if (!items.includes(hit.item)) items.push(hit.item);
  }
  if (items.length > 0) {
    await commit(ctx, { kind: 'check', id: task.fm.id, items, checked: !values.off }, `${values.off ? 'снятие' : 'отметка'} пунктов в ${refOf(task)}`);
    for (const item of items) console.log(`  [${values.off ? ' ' : 'x'}] ${item}`);
  }
  const after = loadTasks(ctx).index.tasks.find((t) => t.fm.id === task.fm.id);
  const progress = after ? progressLine(after) : null;
  if (progress) console.log(progress);
  // Причины — по состоянию после отметок: в списке неотмеченного не должно быть только что отмеченного.
  const problems = missed.map((q) => matchItem((after ?? task).body, q)).flatMap((hit) => ('error' in hit ? [hit.error] : []));
  if (problems.length > 0) {
    const done = items.length > 0 ? `Отмечены не все: фраз без отметки — ${problems.length} из ${queries.length}.` : 'Ничего не отмечено: ни одна фраза не подошла однозначно.';
    throw new UsageError(`${done}\n${problems.map((p) => `В задаче ${refOf(task)} ${p}`).join('\n')}`, 1);
  }
}

async function attach(args: string[]): Promise<void> {
  const { values, positionals } = parse('attach', args, { as: { type: 'string' }, stdin: { type: 'boolean' } }, 2);
  const ref = taskArg(positionals, 'attach');
  const source = positionals[1];
  if (!source) throw new UsageError(values.stdin ? 'Укажите имя вложения: kaiten attach PRJ-123 HANDOFF.md --stdin' : 'Укажите файл: kaiten attach PRJ-123 report.md');
  let name: string;
  let content: Buffer;
  if (values.stdin) {
    name = stringFlag(values, 'as')?.trim() ?? source;
    content = readFileSync(0);
  } else {
    const path = resolve(source);
    if (!existsSync(path) || !statSync(path).isFile()) throw new UsageError(`Нет файла ${source}.`, 1);
    name = stringFlag(values, 'as')?.trim() ?? basename(path);
    content = readFileSync(path);
  }
  name = name.replaceAll('\\', '/');
  // Скриншоты было-…/стало-… — сразу в папку «Было / Стало»: по ней их находит kaiten review.
  if (!stringFlag(values, 'as')) name = visualAttachName(name) ?? name;
  const problem = attachmentNameProblem(name);
  if (problem) throw new UsageError(`Имя вложения «${name}» не годится: ${problem}.`);
  const visualProblem = visualAttachProblem(name, content.length);
  if (visualProblem) throw new UsageError(`Вложение «${name}» не приложено: ${visualProblem}.`, 1);
  if (content.length === 0) throw new UsageError('Файл пуст — прикладывать нечего.', 1);
  if (content.length > ATTACHMENT_MAX_BYTES) {
    throw new UsageError(`Файл больше ${ATTACHMENT_MAX_BYTES / 1024 / 1024} МБ — такие к задаче не прикладываются: положите его в общее хранилище файлов и дайте ссылку в задаче.`, 1);
  }
  const ctx = begin();
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, ref);
  const own = (attachmentRefs(entries).get(task.slug) ?? []).map((a) => a.name);
  const limitProblem = visualLimitProblem(name, own, refOf(task));
  if (limitProblem) throw new UsageError(`Вложение «${name}» не приложено: ${limitProblem}.`, 1);
  let blob: string;
  try {
    blob = storeBlob(ctx.store, content);
  } catch {
    throw new UsageError('Не записано: вложение не сохранить. Повторите kaiten pull; если не поможет — сообщите тому, кто настраивал kaiten.', 1);
  }
  await commit(ctx, { kind: 'attach', id: task.fm.id, name, blob }, `вложение ${name} задачи ${refOf(task)}`);
  console.log(`Прочитать: kaiten files ${refOf(task)} ${name}`);
}

async function detach(args: string[]): Promise<void> {
  const { positionals } = parse('detach', args, {});
  const ref = taskArg(positionals, 'detach');
  const given = positionals.slice(1);
  if (given.length === 0) throw new UsageError('Укажите, что убрать: kaiten detach PRJ-123 было-форма.png стало-форма.png');
  const ctx = begin();
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, ref);
  const own = (attachmentRefs(entries).get(task.slug) ?? []).map((a) => a.name);
  const names: string[] = [];
  const problems: string[] = [];
  for (const asked of given) {
    const target = detachTarget(asked, own);
    if ('problem' in target) problems.push(target.problem);
    else if (!names.includes(target.name)) names.push(target.name);
  }
  if (problems.length > 0) {
    const list = own.filter(isVisualAttachment);
    const have = list.length > 0 ? `\nКартинки задачи: ${list.join(', ')}` : `\nУ задачи нет картинок «Было / Стало».`;
    throw new UsageError(`Ничего не убрано:${problems.map((p) => `\n  - ${p}`).join('')}${have}`, 1);
  }
  await commit(ctx, { kind: 'detach', id: task.fm.id, names }, `${names.length === 1 ? 'вложение' : 'вложения'} задачи ${refOf(task)}`);
  if (names.length > 1) for (const name of names) console.log(`  убрано: ${name}`);
}

async function log(args: string[]): Promise<void> {
  const { values, positionals } = parse('log', args, { stdin: { type: 'boolean' } }, 2);
  const ref = taskArg(positionals, 'log');
  const text = values.stdin ? readStdin() : positionals[1];
  if (!text?.trim()) throw new UsageError('Укажите текст: kaiten log PRJ-123 "что сделано"');
  const ctx = begin();
  currentPerson(ctx.loaded.people);
  const task = findTask(loadTasks(ctx).index, ref);
  await commit(ctx, { kind: 'log', id: task.fm.id, text }, `запись в журнал ${refOf(task)}`);
}

async function withReason(command: 'block' | 'cancel', args: string[]): Promise<void> {
  const { values, positionals } = parse(command, args, { reason: { type: 'string' } }, 1);
  const ref = taskArg(positionals, command);
  const reason = stringFlag(values, 'reason')?.trim();
  if (!reason) throw new UsageError(`--reason: ${command === 'block' ? 'что блокирует задачу' : 'почему задача не нужна'}.`);
  const ctx = begin();
  // Кто вы — до карточки: запись журнала без автора не делается.
  currentPerson(ctx.loaded.people);
  const task = findTask(loadTasks(ctx).index, ref);
  const what = command === 'block' ? `блокировка ${refOf(task)}` : `отмена ${refOf(task)}`;
  // Проверить у себя до карточки: карточку не двигаем, если задачу всё равно не записать.
  const allowed = command === 'block' ? BLOCKABLE : CANCELLABLE;
  if (!allowed.includes(task.fm.status)) {
    const hint = command === 'block' ? 'заблокировать можно только открытую' : `отменить можно только из ${CANCELLABLE.join(', ')}`;
    throw new UsageError(`Не записано: задача ${refOf(task)} в статусе ${task.fm.status}: ${hint}`, 1);
  }
  const queue: MoveStep[] = [];
  const card = await moveCardFirst(ctx, task, command === 'block' ? 'blocked' : 'cancelled', undefined, undefined, queue);
  await commit(ctx, { kind: command, id: task.fm.id, reason, ...queuedOf(queue, card) }, what);
  cardNotMovedNote(card);
}

async function move(command: 'review' | 'done', args: string[]): Promise<void> {
  const { values, positionals } = parse(
    command,
    args,
    { note: { type: 'string' }, 'no-visual': { type: 'string' }, ...(command === 'review' ? { unchecked: { type: 'string' as const }, 'no-ingest': { type: 'string' as const } } : {}) },
    1,
  );
  const ref = taskArg(positionals, command);
  const ctx = begin();
  currentPerson(ctx.loaded.people);
  const { index, entries } = loadTasks(ctx);
  const task = findTask(index, ref);
  const status = command === 'review' ? 'review' : 'done';
  const problem = moveProblem(task, status);
  if (problem) throw new UsageError(`Не записано: ${problem}.`, 1);
  // На ревью — с отмеченными критериями: неотмеченный пункт либо не сделан, либо о нём надо сказать словами.
  const why = stringFlag(values, 'unchecked')?.trim();
  const open = command === 'review' && task.fm.status !== 'review' ? openCriteria(task.body) : [];
  if (open.length > 0 && !why) {
    throw new UsageError(
      `Не записано: в задаче ${refOf(task)} неотмеченные критерии (${open.length}):\n${open.map((i) => `  - ${i}`).join('\n')}\n` +
        `Сделанное отметьте: kaiten check ${refOf(task)} '<слова пункта>'. Пункт не будет сделан в этой работе — скажите почему: kaiten review ${refOf(task)} --unchecked "<причина>".`,
      1,
    );
  }
  // Без записи о работе ревьюер не узнает, что сделано и чем проверено (в испытании её пропускали).
  if (command === 'review' && task.fm.status !== 'review' && !hasWorkNote(task.log)) {
    throw new UsageError(
      `Не записано: в журнале задачи ${refOf(task)} нет записи о работе. Запишите, что сделано, почему так и чем проверено: kaiten log ${refOf(task)} "<что>", — и повторите.`,
      1,
    );
  }
  // Гейты проекта (`core/review-gates.ts`): документация в ветке и прогон проверок на текущем коммите.
  const gates = command === 'review' && task.fm.status !== 'review' ? reviewGateNotes(ctx, task, stringFlag(values, 'no-ingest')) : [];
  const visual = task.fm.status !== status ? visualFor(ctx, task, entries, command, stringFlag(values, 'no-visual')) : undefined;
  const given = stringFlag(values, 'note')?.trim();
  const work = command === 'review' ? workRef(ctx.workDir, given) : undefined;
  // Домен — в запись о сдаче: ревьюер видит, как читать изменения, не открывая постановку.
  const domain = command === 'review' ? domainNote(ctx, task) : undefined;
  const note = [given, work, domain, open.length > 0 && why ? `не отмечено пунктов ${open.length}: ${why}` : undefined, ...gates, visual?.note].filter(Boolean).join('; ') || undefined;
  const queue: MoveStep[] = [];
  const card = task.fm.status !== status ? await moveCardFirst(ctx, task, status, undefined, undefined, queue) : 'none';
  await commit(ctx, { kind: 'move', id: task.fm.id, status, note, ...(visual ? { visual: visual.visual } : {}), ...queuedOf(queue, card) }, `${command === 'review' ? 'ревью' : 'закрытие'} ${refOf(task)}`);
  cardNotMovedNote(card);
}

/**
 * Ответ «Было / Стало» для `review`/`done` — только в проекте, где поле
 * заведено, и у story, tech, bug. Не хватает картинок или причины — отказ до
 * карточки и записи. `undefined` — спрашивать не о чем.
 */
function visualFor(ctx: Context, task: TaskRecord, entries: readonly StoreEntry[], command: 'review' | 'done', noVisual: string | undefined): { visual: VisualAnswer; note?: string } | undefined {
  if (!visualFields(ctx.loaded.project) || !visualApplies(task.fm.type)) return undefined;
  const attachments = (attachmentRefs(entries).get(task.slug) ?? []).map((a) => a.name);
  const decision = visualDecision({ attachments, noVisual, current: task.fm.visual, ref: refOf(task), command });
  if ('problems' in decision) throw new UsageError(`Не записано:${decision.problems.map((p) => `\n  - ${p}`).join('')}`, 1);
  return decision;
}

/** Домен задачи с правилом ревью проекта — для записи о сдаче; проект домены не ведёт или домена нет — ничего. */
function domainNote(ctx: Context, task: TaskRecord): string | undefined {
  const domains = domainsOf(ctx.loaded.project);
  const domain = task.fm.domain;
  if (!domains || domain === undefined) return undefined;
  return domains[domain] ? `домен ${domain} — ${domains[domain]}` : `домен ${domain}`;
}

/** Ветка и последний коммит репозитория кода — для записи «на ревью»: где смотреть работу. */
function workRef(workDir: string, given?: string): string | undefined {
  const branch = git(workDir, ['branch', '--show-current']);
  const head = git(workDir, ['log', '-1', '--format=%h %s']);
  if (!branch.ok || !branch.out || !head.ok || !head.out) return undefined;
  // Ветку уже назвали в --note — второй раз не пишем.
  if (given?.includes(branch.out)) return undefined;
  return `ветка ${branch.out}, коммит ${head.out}`;
}

/** Неотмеченные пункты раздела критериев (первый заголовок на «Критери…»); шаги и прочие списки не считаются. */
export function openCriteria(body: string): string[] {
  return (criteriaText(body) ?? '')
    .split('\n')
    .map((line) => /^\s*(?:[-*+]|\d+[.)])[ \t]+\[ \][ \t]+(\S.*)$/.exec(line)?.[1].trim())
    .filter((text): text is string => text !== undefined);
}

/** Текст задачи для правки — канонический: так его и запишет любая команда. */
export function editableText(task: TaskRecord): string {
  return serializeTaskDocument(task.fm, task.body);
}

/**
 * Домен в правке — по списку проекта. Проверяется только новое значение: прежнее
 * могли поставить до того, как проект поменял список, и правку текста оно не держит.
 */
function editedDomainProblem(ctx: Context, task: TaskRecord, text: string): string | null {
  let domain: unknown;
  try {
    domain = (parseTaskDocument(text).data as { domain?: unknown }).domain;
  } catch {
    return null; // Нечитаемый текст отклонит сама операция — своими словами.
  }
  if (typeof domain !== 'string' || domain === task.fm.domain) return null;
  return domainProblem(ctx.loaded.project, domain);
}

function editorCommand(): string {
  return process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi');
}

async function edit(args: string[]): Promise<void> {
  const { values, positionals } = parse('edit', args, { stdin: { type: 'boolean' } }, 1);
  const ref = taskArg(positionals, 'edit');
  const ctx = begin();
  const task = findTask(loadTasks(ctx).index, ref);
  const baseHash = contentHash(task.fm, task.body);
  const what = `правка ${refOf(task)}`;

  if (values.stdin) {
    const text = readStdin();
    const domain = editedDomainProblem(ctx, task, text);
    if (domain) throw new UsageError(`Не записано: domain: ${domain}.`, 1);
    await commit(ctx, { kind: 'edit', id: task.fm.id, text, baseHash }, what);
    return;
  }

  // Черновик во временной папке — не в репозитории кода.
  const draft = join(tmpdir(), `kaiten-${task.slug}.md`);
  const original = editableText(task);
  writeFileSync(draft, original);
  let previous = original;
  for (;;) {
    const run = spawnSync(`${editorCommand()} "${draft}"`, { shell: true, stdio: 'inherit' });
    if (run.status !== 0) throw new UsageError(`Редактор завершился с ошибкой. Черновик: ${draft}`, 1);
    const text = readFileSync(draft, 'utf8');
    if (text === original) {
      console.log('Без изменений.');
      return;
    }
    if (text === previous && previous !== original) throw new UsageError(`Правка не записана. Черновик: ${draft}`, 1);
    const domain = editedDomainProblem(ctx, task, text);
    const result = domain ? { error: `domain: ${domain}` } : recordOp(ctx.store, { kind: 'edit', id: task.fm.id, text, baseHash }, what, today());
    if (!('error' in result)) {
      console.log(`${result.summary.charAt(0).toUpperCase()}${result.summary.slice(1)}.`);
      for (const w of result.warnings) console.log(`  подсказка: ${w}`);
      if (result.changed) {
        refreshLocalCopy(ctx);
        await startSend(ctx);
      }
      return;
    }
    console.error(`Не записано: ${result.error}\nИсправьте в редакторе и сохраните; закройте без изменений — чтобы бросить правку.`);
    previous = text;
  }
}

export const WRITE_COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  new: newTask,
  check,
  attach,
  detach,
  log,
  block: (args) => withReason('block', args),
  cancel: (args) => withReason('cancel', args),
  review: (args) => move('review', args),
  done: (args) => move('done', args),
  edit,
};

