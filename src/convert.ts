/**
 * Разовый конвертер задач проекта из старых раскладок репозиториев кода в
 * репозиторий задач формата v2 (story `export-csv`). Не команда `kaiten`:
 * нужен один раз, агенту его знать незачем.
 *
 * БЕЗОПАСНОСТЬ. Репозитории кода только читаются (файлы и `git log`). Kaiten
 * — только чтение, и только с `--kaiten`. Без `--write` не пишется ничего,
 * кроме отчёта. Каталог `--out` должен быть пустым или созданным этим же
 * конвертером: чужое дерево не перезаписываем.
 *
 * ФЛАГИ
 *   --config <path>    kaiten.json проекта (обязателен): repos[].path — рабочие копии репозиториев кода со старыми tasks/
 *   --overlay <path>   «Суть» и команда по external_id (по умолч. pilot/overlay.json)
 *   --kaiten           прочитать карточки доски и заполнить `tracker` (нужен токен)
 *   --out <dir>        куда писать дерево репозитория задач
 *   --write            записать дерево в --out
 *   --drafts <path>    черновики «Сути» (по умолч. convert/summaries.json): читаются
 *                      как оверлей ниже --overlay; с --write дополняются новыми
 *                      черновиками с `reviewed: false` — отметка «проверить»
 *                      живёт в git, а не во временном отчёте
 *   --people <path>    люди и их почты в git (по умолч. people из --config)
 *   --report <path>    отчёт (по умолч. tmp/convert/<проект>-report.md)
 *
 * Коды выхода: 0 — ок; 2 — ошибка аргументов или конфига; 6 — ошибка Kaiten.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { loadTasksRepoConfig } from './config.js';
import { convertProject, type CardFields, type OverlayEntry } from './convert/convert-plan.js';
import { readHistory, type TaskHistory } from './convert/git-history.js';
import { lintRepository } from './core/lint.js';
import { PRIORITIES, STATUSES, TASK_TYPES } from './core/schema.js';
import { KaitenClient, type Card } from './kaiten-client.js';
import { collectNumberedTasks } from './numbered-source.js';
import { collectTasks, normalizeRemoteUrl, parseFolderNameLenient, type RepoSource, type SourceIssue, type TaskFile } from './task-source.js';

const MARKER = '.converted-by-kaiten-tracker';

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function repoUrl(repoPath: string, configured?: string): string {
  if (configured) return configured;
  try {
    return normalizeRemoteUrl(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, encoding: 'utf8' })) ?? '';
  } catch {
    return '';
  }
}

const OverlaySchema = z.record(
  z.string(),
  z.object({ summary: z.string().min(1).optional(), team: z.string().optional(), reviewed: z.boolean().optional() }),
);

function readOverlay(path: string): Record<string, OverlayEntry> {
  return existsSync(path) ? OverlaySchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : {};
}

/** Значение поля-выбора карточки (`properties.id_<поле>: [id варианта]`) → ключ маппинга. */
function selectKey(card: Card, property: { id: number; values: Record<string, number> } | undefined): string | undefined {
  if (!property) return undefined;
  const raw = card.properties?.[`id_${property.id}`];
  const valueId = Array.isArray(raw) ? raw[0] : raw;
  return Object.entries(property.values).find(([, id]) => id === valueId)?.[0];
}

/**
 * Всё содержимое папки задачи, кроме `TASK.md`, `LOG.md` и вложенных задач
 * (папка с `TASK.md` или с именем задачи): пути от папки задачи.
 *
 * Только файлы, которые есть в git. Неотслеживаемое (черновики, заметки
 * прогонов на проде) не переносится: там бывают хосты и доступы, а
 * репозиторий задач читают все разработчики проекта. И дерево должно
 * воспроизводиться из коммитов, а не из чьей-то рабочей копии.
 */
function taskFolderFiles(repoPath: string, taskDir: string, tracked: ReadonlySet<string>, untracked: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(repoPath, taskDir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const nestedTask = existsSync(join(repoPath, taskDir, childRel, 'TASK.md')) || parseFolderNameLenient(entry.name) !== null;
        if (!nestedTask) walk(childRel);
      } else if (!(rel === '' && (entry.name === 'TASK.md' || entry.name === 'LOG.md'))) {
        if (tracked.has(`${taskDir}/${childRel}`)) out.push(childRel);
        else untracked.push(`${taskDir}/${childRel}`);
      }
    }
  };
  walk('');
  return out.sort();
}

function gitLines(repoPath: string, args: string[]): string[] {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
}

/** Люди проекта: ключ → имя, и почты авторов коммитов → ключ человека. */
const PeopleSchema = z.object({
  people: z.record(z.string(), z.object({ name: z.string() })),
  emails: z.record(z.string(), z.string()),
});

/** Ключ истории задачи: `<дата>_<slug>` или имя файла globex — как в `external_id` без репозитория. */
function historyKey(task: TaskFile): string {
  return task.externalId.slice(task.repoName.length + 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const configPath = argValue(argv, '--config') ?? fail('Укажите --config <kaiten.json проекта>', 2);
  const loaded = loadTasksRepoConfig(configPath);
  const { project } = loaded;
  const projectKey = loaded.key;
  const base = dirname(resolve(configPath));
  const write = argv.includes('--write');
  const out = argValue(argv, '--out');
  if (write && !out) fail('--write требует --out <каталог>', 2);
  const reportPath = argValue(argv, '--report') ?? `tmp/convert/${projectKey}-report.md`;

  const tasks: TaskFile[] = [];
  const skipped: Array<SourceIssue & { repo: string }> = [];
  const history = new Map<string, TaskHistory>();
  const logs = new Map<string, string>();
  const repoPaths = new Map<string, string>();
  const extraFiles = new Map<string, string[]>();
  const untracked: string[] = [];
  const dirty: string[] = [];

  for (const repo of project.repos.filter((r) => r.path)) {
    const path = isAbsolute(repo.path as string) ? (repo.path as string) : resolve(base, repo.path as string);
    if (!existsSync(path)) fail(`Репозиторий ${repo.name}: нет пути ${path}`, 2);
    repoPaths.set(repo.name, path);
    const source: RepoSource = { name: repo.name, path, url: repoUrl(path, repo.url), branch: repo.branch, tasksDirName: repo.tasksDirName, layout: repo.layout };
    const scan = repo.layout === 'numbered' ? collectNumberedTasks(source) : collectTasks(source, { lenient: true });
    tasks.push(...scan.tasks);
    for (const issue of scan.issues) if (issue.problem !== 'status-mismatch') skipped.push({ ...issue, repo: repo.name });
    const repoHistory = readHistory(path, repo.layout, repo.tasksDirName);
    const tasksDir = repo.tasksDirName ?? 'tasks';
    const tracked = new Set(gitLines(path, ['ls-files', '-z', '--', tasksDir]));
    // Незакоммиченные правки задач: конвертер берёт рабочую копию, пусть это будет видно.
    for (const entry of gitLines(path, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', tasksDir])) {
      if (/^.. /.test(entry)) dirty.push(`${repo.name}: ${entry.slice(3)}`);
    }
    for (const task of scan.tasks) {
      const h = repoHistory.get(historyKey(task));
      if (h) history.set(task.externalId, h);
      if (!task.sourceFile) {
        const before = untracked.length;
        extraFiles.set(task.externalId, taskFolderFiles(path, task.dir, tracked, untracked));
        for (let i = before; i < untracked.length; i += 1) untracked[i] = `${repo.name}: ${untracked[i]}`;
      }
      if (task.hasLog) logs.set(task.externalId, readFileSync(join(path, task.dir, 'LOG.md'), 'utf8'));
    }
  }

  const overlayPath = argValue(argv, '--overlay') ?? 'pilot/overlay.json';
  const draftsPath = argValue(argv, '--drafts') ?? 'convert/summaries.json';
  const draftsFile = readOverlay(draftsPath);
  const pilotOverlay = readOverlay(overlayPath);
  // Оверлей сильнее черновиков: там проверенная «Суть» пилота.
  const overlay: Record<string, OverlayEntry> = { ...draftsFile };
  for (const [id, entry] of Object.entries(pilotOverlay)) overlay[id] = { ...draftsFile[id], ...entry };

  const cards = new Map<string, CardFields>();
  const unmappedColumns: string[] = [];
  if (argv.includes('--kaiten')) {
    const boardId = project.mapping?.boardId;
    if (!boardId) fail('В конфиге нет доски проекта (mapping.boardId)', 2);
    const domain = process.env.KAITEN_DOMAIN;
    const token = process.env.KAITEN_TOKEN;
    if (!domain || !token) fail('Нет KAITEN_DOMAIN/KAITEN_TOKEN', 2);
    const client = new KaitenClient({ domain, token, minIntervalMs: 150 });
    try {
      for (const card of await client.listCards({ boardId })) {
        if (card.external_id === null || card.external_id === undefined) continue;
        const mapping = project.mapping;
        const status = Object.entries(mapping?.columns ?? {}).find(([, id]) => id === card.column_id)?.[0];
        const type = Object.entries(mapping?.types ?? {}).find(([, id]) => id === card.type_id)?.[0];
        const priority = selectKey(card, mapping?.priorityProperty);
        if (status === undefined) unmappedColumns.push(`${String(card.external_id)} (колонка ${card.column_id ?? '—'})`);
        cards.set(String(card.external_id), {
          id: card.id,
          status: STATUSES.find((x) => x === status),
          type: TASK_TYPES.find((x) => x === type),
          priority: PRIORITIES.find((x) => x === priority),
          team: selectKey(card, mapping?.teamProperty),
        });
      }
    } catch (error) {
      fail(`Kaiten: ${(error as Error).message}`, 6);
    }
  }

  const exists = (repoName: string, path: string): boolean => {
    const root = repoPaths.get(repoName);
    return root !== undefined && existsSync(join(root, path));
  };
  const peoplePath = argValue(argv, '--people');
  const people = peoplePath ? PeopleSchema.parse(JSON.parse(readFileSync(peoplePath, 'utf8'))) : loaded.people;
  const person = (commit: { author: string; email: string }): string | undefined => people.emails[commit.email.toLowerCase()];
  const result = convertProject({ tasks, history, logs, overlay, cards, exists, extraFiles, person });
  const lint = lintRepository(
    result.files.filter((f) => !f.path.endsWith('.log.md')),
    project.repos.map((r) => r.name),
  );
  const errorClasses = new Map<string, number>();
  const warningClasses = new Map<string, number>();
  for (const file of lint.byFile) {
    for (const issue of file.issues) {
      const cls = issue.message.replace(/«[^»]*»|\d+/g, '…').slice(0, 90);
      const map = issue.level === 'error' ? errorClasses : warningClasses;
      map.set(cls, (map.get(cls) ?? 0) + 1);
    }
  }
  let attachmentBytes = 0;
  const bigFiles: Array<{ path: string; size: number }> = [];
  for (const a of result.attachments) {
    const size = statSync(join(repoPaths.get(a.repoName) as string, a.from)).size;
    attachmentBytes += size;
    if (size > 50 * 1024 * 1024) bigFiles.push({ path: `${a.repoName}/${a.from}`, size });
  }
  const unknownCards = [...cards.keys()].filter((id) => !tasks.some((t) => t.externalId === id));

  const r = result.report;
  const lines = [
    `# Конвертация проекта ${projectKey} в формат v2`,
    '',
    `Источников задач: ${tasks.length + skipped.filter((s) => s.problem !== 'lenient-folder-name').length}; конвертировано: ${r.converted}; не конвертировано: ${skipped.filter((s) => s.problem !== 'lenient-folder-name').length}.`,
    `По статусам: ${Object.entries(r.byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `Файлов в дереве: ${result.files.length}, вложений: ${r.attachments}. Карточек Kaiten сопоставлено: ${r.trackers}${argv.includes('--kaiten') ? '' : ' (без --kaiten)'}.`,
    `Линтер: ошибок ${lint.errors}, предупреждений ${lint.warnings}.`,
    '',
    '## Не конвертировано или взято с оговоркой',
    ...skipped.map((s) => `- ${s.repo}: \`${s.dir}\` — ${s.detail}`),
    ...(unknownCards.length ? [`- Карточки Kaiten без задачи в источниках: ${unknownCards.join(', ')}`] : []),
    '',
    `## Не перенесено: файлы вне git (${untracked.length})`,
    ...untracked.map((f) => `- \`${f}\``),
    '',
    `## Незакоммиченные правки задач в источниках — взята рабочая копия (${dirty.length})`,
    ...dirty.map((f) => `- \`${f}\``),
    '',
    `## Вложения: ${result.attachments.length} файлов, ${(attachmentBytes / 1024 / 1024).toFixed(1)} МБ`,
    ...bigFiles.map((f) => `- крупный файл: \`${f.path}\` — ${(f.size / 1024 / 1024).toFixed(1)} МБ (GitHub не примет больше 100 МБ)`),
    '',
    '## Ошибки линтера по файлам',
    ...lint.byFile.flatMap((f) => f.issues.filter((i) => i.level === 'error').map((i) => `- \`${f.path}\`: ${i.message}`)),
    '',
    '## Ошибки линтера по классам',
    ...[...errorClasses].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${v} × ${k}`),
    '',
    '## Предупреждения линтера по классам',
    ...[...warningClasses].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${v} × ${k}`),
    '',
    `## Кто завёл задачи (${Object.keys(r.authors).length})`,
    ...Object.entries(r.authors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    '',
    `## Авторы git без записи в ${peoplePath} (${Object.keys(r.unknownAuthors).length})`,
    ...Object.entries(r.unknownAuthors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    '',
    `## Родители (${r.parentProblems.length})`,
    ...r.parentProblems.map((p) => `- ${p.externalId}: ${p.problem}`),
    '',
    `## Переименованные slug (${r.slugRenames.length})`,
    ...r.slugRenames.map((s) => `- ${s.externalId}: ${s.from} → ${s.to}`),
    '',
    `## Ссылки на задачи, которые не разрешились (${r.unresolvedLinks.length})`,
    ...r.unresolvedLinks.map((l) => `- ${l.externalId}: ${l.target}`),
    '',
    `## Без истории git — created и created_by заглушки, id выведен из заглушки (${r.noHistory.length})`,
    ...r.noHistory.map((id) => `- ${id}`),
    '',
    `## Карточки в колонке вне маппинга — статус по папке (${unmappedColumns.length})`,
    ...unmappedColumns.map((c) => `- ${c}`),
    '',
    `## Тип, приоритет, команда из Kaiten, а не из файла (${r.kaitenFields.length})`,
    ...r.kaitenFields.map((k) => `- ${k.externalId}: ${k.field} ${k.file} → ${k.kaiten}`),
    '',
    `## Статус из Kaiten, а не из папки (${r.kaitenStatus.length})`,
    ...r.kaitenStatus.map((k) => `- ${k.externalId}: папка ${k.folder}, Kaiten ${k.kaiten}`),
    '',
    `## Статус в шапке расходится с папкой — взята папка (${r.statusMismatch.length})`,
    ...r.statusMismatch.map((m) => `- ${m.externalId}: шапка «${m.header}», папка ${m.folder}`),
    '',
    `## «Суть» — механический черновик, проверить (${r.summaryDrafts.length})`,
    ...r.summaryDrafts.map((id) => `- ${id}`),
    '',
  ];
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`Проект ${projectKey}: конвертировано ${r.converted}, не конвертировано ${skipped.filter((s) => s.problem !== 'lenient-folder-name').length}, файлов ${result.files.length}, вложений ${r.attachments}`);
  console.log(`Линтер: ошибок ${lint.errors}, предупреждений ${lint.warnings}. «Суть» на проверку: ${r.summaryDrafts.length}. Карточек сопоставлено: ${r.trackers}`);
  console.log(`Отчёт: ${reportPath}`);

  if (write) {
    // Черновики «Сути» — в файл этого репозитория: отметка «проверить» не
    // должна жить только во временном отчёте. Проверенные записи не трогаем.
    const merged: Record<string, OverlayEntry> = { ...draftsFile };
    for (const [id, summary] of Object.entries(result.drafts)) if (!merged[id]) merged[id] = { summary, reviewed: false };
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(dirname(draftsPath), { recursive: true });
    writeFileSync(draftsPath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Черновики «Сути»: ${draftsPath} (${Object.keys(result.drafts).length} новых)`);
  }
  if (!write || !out) {
    console.log('Сухой прогон: дерево не записано (--out <dir> --write).');
    return;
  }
  if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, MARKER))) {
    fail(`Каталог ${out} не пуст и создан не конвертером — не трогаю`, 2);
  }
  for (const file of result.files) {
    mkdirSync(dirname(join(out, file.path)), { recursive: true });
    writeFileSync(join(out, file.path), file.text);
  }
  for (const a of result.attachments) {
    mkdirSync(dirname(join(out, a.to)), { recursive: true });
    copyFileSync(join(repoPaths.get(a.repoName) as string, a.from), join(out, a.to));
  }
  writeFileSync(join(out, MARKER), 'Дерево создано конвертером kaiten-tracker (npm run convert). Повторный прогон перезаписывает файлы.\n');
  console.log(`Записано в ${out}`);
}

main().catch((error: unknown) => fail((error as Error).stack ?? String(error), 1));
