/**
 * Скрипт владельца: оценка задач агентом (docs/junior-readiness.md, этап 2).
 * По каждой открытой story/tech/bug агент читает постановку, код и сценарии
 * n8n и выносит вердикт «Актуальна» / «Похоже, сделана» / «Похоже, устарела»;
 * у актуальной — дописывает недостающие разделы для младшего.
 *
 *   npm run assess -- --tasks <адрес> --code acme-app=<папка> --code acme-n8n=<папка>
 *   npm run assess -- --tasks <адрес> --apply <файл результатов>
 *
 * Без `--apply` — только агент и отчёт: markdown для чтения и файл
 * результатов (JSON); ни в задачи, ни в Kaiten ничего не пишется. `--apply`
 * агента не запускает, а применяет ровно переданный файл: разделы — правкой
 * задачи, «Оценку» — в карточку, доказательства — комментарием. Несогласны с
 * задачей — удалите её запись из файла.
 *
 * ФЛАГИ
 *   --tasks <адрес|папка>  репозиторий задач (как у kaiten-sync); --apply — только адрес
 *   --code <репо>=<папка>  рабочая копия репозитория кода; общие (`repos[].shared`) — обязательно
 *   --only <задача>        одна задача (ключ, id или slug)
 *   --force                вместе с --only: оценить заново, даже если оценку поставил человек
 *   --limit N              не больше N задач
 *   --parallel N           агентов одновременно (по умолчанию 2)
 *   --model <модель>       по умолчанию claude-opus-5-5; Haiku не используем
 *   --out <папка>          куда положить отчёт и файл результатов (по умолчанию — временная папка)
 *   --apply <файл>         применить файл результатов
 *
 * Агент — `claude -p` только на чтение: Read, Grep, Glob и `git log`/`git show`;
 * ни записи, ни MCP, ни сети, кроме самой модели. Его ответ проверяется до
 * отчёта (`core/assess.ts`): файлы и коммиты — по папкам, разделы — разбором.
 *
 * Коды выхода: 0 — ок; 1 — были ошибки; 2 — ошибка аргументов.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { modelProblem, runClaude } from './claude-agent.js';
import { assessField, juniorSetting } from './config.js';
import {
  AgentAnswerSchema,
  formatReport,
  planApply,
  ResultsFileSchema,
  runAssess,
  selectForAssess,
  VERDICT_LABELS,
  type AgentRunner,
  type CodeRepo,
  type EvidenceCheck,
  type ResultsFile,
} from './core/assess.js';
import { serializeTaskDocument } from './core/document.js';
import { buildIndex, refOf, resolveTask } from './core/tasks-index.js';
import { KaitenClient } from './kaiten-client.js';
import { SETTINGS_PATH, today } from './kaiten-cli.js';
import { loadSettings } from './kaiten-context.js';
import { loadOwnerProject } from './owner-project.js';
import { KAITEN_LOCK, recordOp, syncStore, withLockAsync } from './store-write.js';
import { listEntries, readStoreTree } from './task-store.js';
import { readTasksTree } from './tasks-files.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
/** Один агент дольше — что-то пошло не так: задача в «не справился», а не зависший прогон. */
const AGENT_TIMEOUT_MS = 20 * 60_000;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

function argValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((a, i) => (a === name && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
}

function intArg(argv: readonly string[], name: string, fallback: number): number {
  const raw = argValue(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${name}: целое число больше нуля`);
  return n;
}

function gitOk(folder: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ── агент ────────────────────────────────────────────────────────────────

/**
 * `claude -p` на задачу: текущая папка — репозиторий задачи, общие — через
 * `--add-dir`. Инструменты — только чтение; git — только log и show (и через
 * `git -C <папка>` по любой из папок). MCP-серверы не подключаются.
 */
function claudeRunner(model: string, repos: readonly CodeRepo[]): AgentRunner {
  return ({ prompt, repo }) =>
    runClaude({
      model,
      cwd: repo.folder,
      prompt,
      schema: AgentAnswerSchema,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      // `git -C` — и для папки задачи: агент пишет его и по своей папке, и отказ ослаблял доказательства (живьём 21.10).
      allowed: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', ...repos.flatMap((r) => [`Bash(git -C ${r.folder} log:*)`, `Bash(git -C ${r.folder} show:*)`])],
      addDirs: repos.filter((r) => r.name !== repo.name).map((r) => r.folder),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
}

/**
 * Доказательства — по основной ветке папки (её проверили при запуске): файл
 * или папка — в её последнем коммите, коммит — в её истории или в другой
 * ветке (своей или с сервера) с меткой ветки. Исправление только в ветке
 * задачи — ещё не сделано (живьём 20.10: агент счёл сделанной задачу, чья
 * правка не влита), но доказательство того, что работа идёт (живьём 21.10:
 * выкат в ветке выката, проверка в ветке задачи).
 */
function folderCheck(repos: readonly CodeRepo[]): EvidenceCheck {
  const folder = (name: string): string | undefined => repos.find((r) => r.name === name)?.folder;
  return {
    repos: new Set(repos.map((r) => r.name)),
    fileExists: (name, path) => {
      const root = folder(name);
      return root !== undefined && gitOk(root, ['cat-file', '-e', `HEAD:${path}`]) !== null;
    },
    commitBranches: (name, sha) => {
      const root = folder(name);
      if (!root || gitOk(root, ['cat-file', '-e', `${sha}^{commit}`]) === null) return [];
      if (gitOk(root, ['merge-base', '--is-ancestor', sha, 'HEAD']) !== null) return 'head';
      const refs = gitOk(root, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']) ?? '';
      const names = refs
        .split('\n')
        .filter((ref) => ref && !ref.endsWith('/HEAD'))
        .map((ref) => ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, ''));
      return [...new Set(names)].sort();
    },
  };
}

// ── сухой прогон: оценка ─────────────────────────────────────────────────

async function assess(argv: string[]): Promise<void> {
  const owner = loadOwnerProject(argv);
  const { key, project } = owner.loaded;
  const junior = juniorSetting(project);
  if (junior.state === 'off') fail(`У проекта ${project.title} признак «Можно младшему» не включён (kaiten.junior в kaiten.json) — оценивать не для чего.`);
  if (!assessField(project)) fail('Поля «Оценка» в Kaiten нет — сначала npm run setup (план → --apply), id полей — в kaiten.json.');

  const model = argValue(argv, '--model') ?? DEFAULT_MODEL;
  const badModel = modelProblem(model);
  if (badModel) fail(`--model: ${badModel}.`);

  const repos: CodeRepo[] = [];
  for (const spec of argValues(argv, '--code')) {
    const m = /^([^=]+)=(.+)$/.exec(spec);
    if (!m) fail(`--code ${spec}: нужно <репозиторий>=<папка>`);
    const [, name, path] = m;
    const config = project.repos.find((r) => r.name === name);
    if (!config) fail(`--code ${name}: в проекте нет такого репозитория (есть: ${project.repos.map((r) => r.name).join(', ')})`);
    const dir = resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--code ${name}: нет папки ${dir}`);
    const top = gitOk(dir, ['rev-parse', '--show-toplevel']);
    if (top === null) fail(`--code ${name}: ${dir} — не рабочая копия git`);
    // Сделано — то, что в основной ветке: папка на ветке задачи показала бы невлитую правку сделанной.
    const branch = gitOk(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== config.branch) fail(`--code ${name}: папка на ветке ${branch ?? '?'}, а оценивают по ${config.branch} — переключите её (git switch ${config.branch}) или дайте другую копию`);
    if (gitOk(top, ['status', '--porcelain', '--untracked-files=no'])) fail(`--code ${name}: в папке незакоммиченные правки — оценка была бы не по ${config.branch}`);
    repos.push({ name, folder: top.replace(/\\/g, '/'), shared: config.shared });
  }
  const missingShared = project.repos.filter((r) => r.shared && !repos.some((c) => c.name === r.name));
  // Без общего репозитория агент не увидит сценариев n8n и напишет ложное «Нет».
  if (missingShared.length > 0) fail(`Нужны папки общих репозиториев: ${missingShared.map((r) => `--code ${r.name}=<папка>`).join(' ')}`);
  if (repos.length === 0) fail('Укажите папки с кодом: --code <репозиторий>=<папка>');

  const tree = owner.source.kind === 'store' ? readStoreTree(owner.source.store, listEntries(owner.source.store)) : owner.source.kind === 'dir' ? readTasksTree(owner.source.dir) : fail('--config без --tasks: укажите, откуда брать задачи');
  const index = buildIndex(tree.files, tree.logs);
  if (index.problems.length > 0) console.error(`Не читается задач: ${index.problems.length} — они не участвуют.`);

  const onlyRef = argValue(argv, '--only');
  let only: Set<string> | undefined;
  if (onlyRef) {
    const found = resolveTask(index.tasks, onlyRef);
    if ('error' in found) fail(found.error);
    only = new Set([found.task.fm.id]);
  }
  const force = argv.includes('--force');
  if (force && !only) fail('--force — только вместе с --only <задача>: оценку человека заново не оцениваем пачкой');

  const date = today();
  const selection = selectForAssess(index.tasks, { today: date, maxAgeDays: junior.maxAgeDays, codeRepos: new Set(repos.map((r) => r.name)), only, force });
  const limit = intArg(argv, '--limit', Number.MAX_SAFE_INTEGER);
  const picked = selection.picked.slice(0, limit);
  const parallel = intArg(argv, '--parallel', 2);
  const heads = repos.map((r) => `${r.name} @ ${gitOk(r.folder, ['rev-parse', '--short', 'HEAD']) ?? '?'} (${gitOk(r.folder, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? '?'})`);

  console.log(`Проект ${project.title}: оцениваю задач ${picked.length}${selection.picked.length > picked.length ? ` из ${selection.picked.length} (--limit)` : ''}, пропущено ${selection.skipped.length}. Модель ${model}, по ${parallel} за раз.`);
  console.log(`Код: ${heads.join('; ')}`);
  let finished = 0;
  const run = await runAssess(picked, {
    repos,
    taskText: (t) => serializeTaskDocument(t.fm, t.body),
    run: claudeRunner(model, repos),
    check: folderCheck(repos),
    parallel,
    onDone: (t, ok) => console.log(`[${++finished}/${picked.length}] ${refOf(t)} ${t.fm.title} — ${ok ? 'оценена' : 'агент не справился'}`),
  });

  const created = new Date().toISOString();
  const results: ResultsFile = { version: 1, project: key, created, model, results: run.results };
  const out = resolve(argValue(argv, '--out') ?? join(tmpdir(), 'kaiten-assess'));
  mkdirSync(out, { recursive: true });
  const stamp = created.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const jsonPath = join(out, `${key}-${stamp}.json`);
  const mdPath = join(out, `${key}-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, formatReport({ project: project.title, created, model, heads, run, skipped: selection.skipped }), 'utf8');

  const count = (v: keyof typeof VERDICT_LABELS): number => run.results.filter((r) => r.verdict === v).length;
  console.log(
    `\nОценено ${run.results.length}: «Актуальна» — ${count('actual')}, «Похоже, сделана» — ${count('done')}, «Похоже, устарела» — ${count('obsolete')}; агент не справился — ${run.failed.length}. Стоимость ≈ $${run.costUsd.toFixed(2)}.`,
  );
  console.log(`Отчёт: ${mdPath}`);
  console.log(`Результаты: ${jsonPath}`);
  console.log('\nСухой прогон: ни в задачи, ни в Kaiten ничего не записано. Применить: --apply <файл результатов>.');
  if (run.failed.length > 0) process.exitCode = 1;
}

// ── применение ───────────────────────────────────────────────────────────

async function apply(argv: string[], file: string): Promise<void> {
  const owner = loadOwnerProject(argv);
  const { key, project } = owner.loaded;
  if (owner.source.kind !== 'store') fail('--apply пишет в задачи — только из хранилища задач: --tasks <адрес репозитория задач>');
  const store = owner.source.store;
  const field = assessField(project) ?? fail('Поля «Оценка» в Kaiten нет — сначала npm run setup.');

  let results: ResultsFile;
  try {
    results = ResultsFileSchema.parse(JSON.parse(readFileSync(resolve(file), 'utf8')));
  } catch (error) {
    fail(`Файл результатов не читается: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
  if (results.project !== key) fail(`Файл результатов — проекта ${results.project}, а задачи — ${key}`);

  const settings = loadSettings(SETTINGS_PATH);
  const domain = process.env.KAITEN_DOMAIN ?? settings.kaiten?.domain;
  const token = process.env.KAITEN_TOKEN ?? settings.kaiten?.token;
  if (!domain || !token) fail('Нет входа в Kaiten: KAITEN_DOMAIN/KAITEN_TOKEN в .env или kaiten в настройках');
  const client = new KaitenClient({ domain, token, minIntervalMs: 150 });

  const date = today();
  let applied = 0;
  let errors = 0;
  // Под замком синхронизации: иначе фон прочёл бы карточку с оценкой раньше, чем в файле появится отметка скрипта, и записал бы её как оценку человека.
  await withLockAsync(store, KAITEN_LOCK, async () => {
    const tree = readStoreTree(store, listEntries(store));
    const tasks = buildIndex(tree.files, tree.logs).tasks;
    for (const result of results.results) {
      const name = `${result.ref} ${result.title}`;
      const task = tasks.find((t) => t.fm.id === result.id);
      const step = planApply(result, task, date);
      if ('error' in step) {
        console.error(`Не применено: ${name} — ${step.error}`);
        errors += 1;
        continue;
      }
      // Сначала разделы: комментарий в карточке говорит, что они дописаны, — это должно быть правдой.
      // Не дошло до Kaiten — разделы остаются (полные разделы признак засчитывает), оценки нет: оцените снова.
      if (step.text !== null) {
        const edited = recordOp(store, { kind: 'edit', id: result.id, text: step.text, baseHash: result.baseHash }, `разделы для младшего: ${result.ref}`, date);
        if ('error' in edited) {
          console.error(`Разделы не записаны: ${name} — ${edited.error}`);
          errors += 1;
          continue;
        }
      }
      try {
        await client.updateCard(result.cardId, { properties: { [`id_${field.id}`]: [field.values[result.verdict]] } });
      } catch (error) {
        console.error(`«Оценка» не записана в Kaiten: ${name} — ${error instanceof Error ? error.message : String(error)}`);
        errors += 1;
        continue;
      }
      // Отметка — сразу за полем: без неё оценку в карточке синхронизация сочла бы оценкой человека.
      const marked = recordOp(store, { kind: 'assessed', items: [{ id: result.id, verdict: result.verdict }] }, `оценка: ${result.ref}`, date);
      if ('error' in marked) {
        console.error(`Отметка оценки не записана: ${name} — ${marked.error}`);
        errors += 1;
        continue;
      }
      try {
        await client.addComment(result.cardId, step.comment);
      } catch (error) {
        console.error(`Комментарий с доказательствами не записан: ${name} — ${error instanceof Error ? error.message : String(error)}; они — в отчёте`);
        errors += 1;
      }
      applied += 1;
      console.log(`${name} — «${VERDICT_LABELS[result.verdict]}»${step.text !== null ? ', разделы дописаны' : ''}`);
    }
  });
  if (applied > 0) syncStore(store);
  console.log(`\nПрименено ${applied} из ${results.results.length}. «Можно младшему» в карточках обновит ближайшая синхронизация (kaiten pull).`);
  if (errors > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('npm run assess -- --tasks <адрес> --code <репо>=<папка> [--only <задача> [--force]] [--limit N] [--parallel N] [--model M] [--out <папка>]');
    console.log('npm run assess -- --tasks <адрес> --apply <файл результатов>');
    return;
  }
  if (argv.includes('--apply')) {
    const file = argValue(argv, '--apply') ?? fail('--apply <файл результатов>: какой файл применить');
    await apply(argv, file);
  } else {
    await assess(argv);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
