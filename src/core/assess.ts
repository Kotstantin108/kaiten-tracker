/**
 * Оценка задач агентом (`npm run assess`, docs/junior-readiness.md) — чистая
 * часть: какие задачи оценивать, что агент должен ответить, как проверить
 * его ответ до записи и что записать при `--apply`.
 *
 * Агент только читает (постановку, код, сценарии n8n) и выносит вердикт:
 * «Актуальна» — с текстом недостающих разделов для младшего; «Похоже,
 * сделана» или «Похоже, устарела» — с доказательствами. Задачи закрывает
 * только человек: вердикты «похоже…» статус не меняют.
 *
 * Ответу агента не верим на слово: каждый файл должен лежать в переданных
 * папках, каждый коммит — быть в одной из их веток (не в основной — с меткой
 * ветки; «похоже…» только по таким не принимается), каждое «Нет» в разделе —
 * обосновано, разделы — проходить разбор признака. Не прошёл — «агент не
 * справился» в отчёте, без записи и без повтора вслепую.
 */

import { z } from 'zod';

import { contentHash, serializeTaskDocument } from './document.js';
import {
  assessedBy,
  daysBetween,
  incompleteSections,
  JUNIOR_SECTIONS,
  ASSESS_STATUSES,
  JUNIOR_TYPES,
  proposedSectionProblems,
  saysNo,
  withJuniorSections,
} from './junior.js';
import { ASSESS_VERDICTS, type AssessVerdict } from './schema.js';
import { sectionText } from './skeleton.js';
import { refOf, type TaskRecord } from './tasks-index.js';

/** Подписи вердиктов — как варианты поля «Оценка» в Kaiten. */
export const VERDICT_LABELS: Record<AssessVerdict, string> = { actual: 'Актуальна', done: 'Похоже, сделана', obsolete: 'Похоже, устарела' };

// ── отбор ────────────────────────────────────────────────────────────────

export interface AssessSelection {
  picked: TaskRecord[];
  /** Задачи, которые оценивались бы, но не будут, — с причиной для отчёта. */
  skipped: Array<{ task: TaskRecord; why: string }>;
}

export interface SelectOptions {
  /** Сегодня, YYYY-MM-DD. */
  today: string;
  /** Через сколько дней «Актуальна» от скрипта устаревает и задача оценивается снова. */
  maxAgeDays: number;
  /** Репозитории, для которых передана папка с кодом. */
  codeRepos: ReadonlySet<string>;
  /** Только эти задачи (id). */
  only?: ReadonlySet<string>;
  /** Оценить заново, даже если оценку поставил человек, — только вместе с `only`. */
  force?: boolean;
}

/**
 * Что оценивать: открытые story/tech/bug во «Входящих», «Бэклоге», «Готово к
 * работе» с карточкой в Kaiten — без оценки или с «Актуальна» от скрипта
 * старше `maxAgeDays`. «Похоже…» от скрипта ждёт человека; оценку человека
 * скрипт не трогает (заново — только `force`).
 */
export function selectForAssess(tasks: readonly TaskRecord[], opts: SelectOptions): AssessSelection {
  const out: AssessSelection = { picked: [], skipped: [] };
  for (const task of tasks) {
    const named = opts.only?.has(task.fm.id) === true;
    if (opts.only && !named) continue;
    const skip = (why: string): void => {
      out.skipped.push({ task, why });
    };
    if (!JUNIOR_TYPES.includes(task.fm.type) || !ASSESS_STATUSES.includes(task.fm.status)) {
      // Остальные задачи не оцениваются вовсе; в отчёте — только названная явно.
      if (named) skip(`оцениваются только открытые ${JUNIOR_TYPES.join('/')} в ${ASSESS_STATUSES.join(', ')}`);
      continue;
    }
    if (task.fm.tracker === undefined || !/^\d+$/.test(task.fm.tracker)) {
      skip('нет карточки в Kaiten — оценку некуда поставить');
      continue;
    }
    const by = assessedBy(task.fm);
    const forced = named && opts.force === true;
    if (by === 'human' && !forced) {
      skip(`оценку «${VERDICT_LABELS[task.fm.assessment ?? 'actual']}» поставил человек — заново только --only ${refOf(task)} --force`);
      continue;
    }
    if (by === 'script' && !forced) {
      const { verdict, date } = task.fm.assessed ?? { verdict: 'actual', date: opts.today };
      if (verdict !== 'actual') {
        skip(`«${VERDICT_LABELS[verdict]}» от ${date} ждёт человека`);
        continue;
      }
      if (daysBetween(date, opts.today) <= opts.maxAgeDays) {
        skip(`оценена ${date}`);
        continue;
      }
    }
    if (task.fm.repo === undefined || !opts.codeRepos.has(task.fm.repo)) {
      skip(`нет папки с кодом ${task.fm.repo ?? '(репозиторий не указан)'} — --code ${task.fm.repo ?? '<репозиторий>'}=<папка>`);
      continue;
    }
    out.picked.push(task);
  }
  return out;
}

// ── ответ агента ─────────────────────────────────────────────────────────

const SECTION_NAMES = JUNIOR_SECTIONS.map((s) => s.name) as [string, ...string[]];

/**
 * Ответ агента — структурированный вывод `claude -p --json-schema`. Все поля
 * обязательны, пустое — пустой строкой: так схема проще и модели, и проверке.
 */
export const AgentAnswerSchema = z
  .object({
    verdict: z.enum(ASSESS_VERDICTS).describe('actual — делать есть смысл; done — код уже на месте; obsolete — модуль удалён, сценарий переписан, смысл потерян'),
    reasoning: z.string().describe('Почему такой вердикт: 2–5 коротких предложений по-русски'),
    sections: z
      .array(
        z
          .object({
            name: z.enum(SECTION_NAMES),
            text: z.string().describe('Текст раздела без заголовка: «Нет — …» или все пункты **Метка:** текст'),
            noReason: z.string().describe('Если текст начинается с «Нет» — что проверено в коде или сценариях; иначе пустая строка'),
          })
          .strict(),
      )
      .describe('Только разделы, которые просили дописать; при done и obsolete — пустой список'),
    evidence: z
      .array(
        z
          .object({
            repo: z.string().describe('Имя репозитория из списка'),
            path: z.string().describe('Путь к существующему файлу или папке относительно корня репозитория; нет — пустая строка'),
            commit: z.string().describe('Хеш коммита из любой ветки репозитория; нет — пустая строка'),
            note: z.string().describe('Что это доказывает'),
          })
          .strict(),
      )
      .describe('Доказательства; при done и obsolete — хотя бы одно'),
  })
  .strict();
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

export interface Evidence {
  repo: string;
  path?: string;
  commit?: string;
  /** Коммит не в основной ветке: в каких ветках он лежит. */
  branches?: string[];
  note: string;
}

/** Проверенная оценка одной задачи — запись файла результатов. */
export const AssessResultSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    title: z.string(),
    cardId: z.number(),
    /** Хеш постановки на момент оценки: изменилась — запись не применяется. */
    baseHash: z.string(),
    verdict: z.enum(ASSESS_VERDICTS),
    reasoning: z.string(),
    /** Тексты разделов, которые будут дописаны в задачу, по заголовку. */
    sections: z.record(z.string(), z.string()),
    /** Обоснование каждого «Нет» по заголовку раздела. */
    noReasons: z.record(z.string(), z.string()),
    evidence: z.array(z.object({ repo: z.string(), path: z.string().optional(), commit: z.string().optional(), branches: z.array(z.string()).optional(), note: z.string() }).strict()),
  })
  .strict();
export type AssessResult = z.infer<typeof AssessResultSchema>;

export const ResultsFileSchema = z
  .object({
    version: z.literal(1),
    project: z.string(),
    /** Когда оценивали, ISO. */
    created: z.string(),
    model: z.string(),
    results: z.array(AssessResultSchema),
  })
  .strict();
export type ResultsFile = z.infer<typeof ResultsFileSchema>;

/**
 * Чем проверить доказательства: файл — в последнем коммите текущей ветки
 * папки; коммит — `head`, если он в её истории, иначе ветки, в которых он
 * лежит (пусто — ни в одной).
 */
export interface EvidenceCheck {
  repos: ReadonlySet<string>;
  fileExists: (repo: string, path: string) => boolean;
  commitBranches: (repo: string, sha: string) => 'head' | readonly string[];
}

/** Путь внутри репозитория: относительный, без выхода наружу. */
export function safeRelativePath(path: string): string | null {
  const p = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((part) => part === '..')) return null;
  return p.replace(/\/+$/, '');
}

/**
 * Ответ агента → запись результатов или список того, что в ответе не так.
 * Разделы берутся только те, что просили (`wanted`): полные разделы
 * человека скрипт не переписывает.
 */
export function verifyAnswer(task: TaskRecord, answer: AgentAnswer, wanted: readonly string[], check: EvidenceCheck): { result: AssessResult } | { problems: string[] } {
  const problems: string[] = [];
  if (!answer.reasoning.trim()) problems.push('нет обоснования вердикта');

  const evidence: Evidence[] = [];
  for (const e of answer.evidence) {
    const where = `${e.repo}${e.path ? `: ${e.path}` : ''}${e.commit ? ` @ ${e.commit}` : ''}`;
    if (!check.repos.has(e.repo)) {
      problems.push(`доказательство из репозитория «${e.repo}», которого агенту не давали`);
      continue;
    }
    const item: Evidence = { repo: e.repo, note: e.note.trim() };
    if (e.path.trim()) {
      const path = safeRelativePath(e.path);
      if (path === null) problems.push(`путь вне репозитория: ${where}`);
      else if (!check.fileExists(e.repo, path)) problems.push(`нет такого файла: ${where}`);
      else item.path = path;
    }
    if (e.commit.trim()) {
      const sha = e.commit.trim().toLowerCase();
      if (!/^[0-9a-f]{7,40}$/.test(sha)) problems.push(`не хеш коммита: ${where}`);
      else {
        const at = check.commitBranches(e.repo, sha);
        if (at === 'head') item.commit = sha;
        else if (at.length === 0) problems.push(`нет такого коммита ни в одной ветке: ${where}`);
        else {
          item.commit = sha;
          item.branches = [...at];
        }
      }
    }
    if (!e.path.trim() && !e.commit.trim()) problems.push(`доказательство без файла и коммита: ${e.repo}`);
    if (!item.note) problems.push(`не сказано, что доказывает: ${where}`);
    evidence.push(item);
  }

  const sections: Record<string, string> = {};
  const noReasons: Record<string, string> = {};
  if (answer.verdict === 'actual') {
    for (const name of wanted) {
      const given = answer.sections.filter((s) => s.name === name);
      if (given.length === 0) {
        problems.push(`нет раздела «${name}»`);
        continue;
      }
      if (given.length > 1) problems.push(`раздел «${name}» дважды`);
      const { text, noReason } = given[0];
      for (const p of proposedSectionProblems(name, text)) problems.push(`раздел «${name}»: ${p}`);
      if (saysNo(text)) {
        if (!noReason.trim()) problems.push(`«Нет» в разделе «${name}» без обоснования`);
        else noReasons[name] = noReason.trim();
      }
      sections[name] = text.trim();
    }
  } else if (evidence.length === 0) {
    problems.push(`«${VERDICT_LABELS[answer.verdict]}» без доказательств`);
  } else if (!evidence.some((e) => e.path !== undefined || (e.commit !== undefined && !e.branches))) {
    // Правка только в ветке задачи — ещё не сделано (живьём 20.10 агент счёл сделанной невлитую).
    const branches = [...new Set(evidence.flatMap((e) => e.branches ?? []))];
    problems.push(`«${VERDICT_LABELS[answer.verdict]}» только по коммитам вне основной ветки (${branches.join(', ')}) — пока не влито, это «Актуальна»`);
  }

  if (problems.length > 0) return { problems };
  return {
    result: {
      id: task.fm.id,
      ref: refOf(task),
      title: task.fm.title,
      cardId: Number(task.fm.tracker),
      baseHash: contentHash(task.fm, task.body),
      verdict: answer.verdict,
      reasoning: answer.reasoning.trim(),
      sections,
      noReasons,
      evidence,
    },
  };
}

// ── задание агенту ───────────────────────────────────────────────────────

export interface CodeRepo {
  name: string;
  /** Папка рабочей копии, прямыми слэшами. */
  folder: string;
  /** Общий репозиторий (`repos[].shared`), а не репозиторий задачи. */
  shared: boolean;
}

/** Задание агенту по одной задаче: постановка, где смотреть код, что ответить. */
export function assessPrompt(task: TaskRecord, taskText: string, repos: readonly CodeRepo[], wanted: readonly string[]): string {
  const own = repos.find((r) => r.name === task.fm.repo);
  const repoLines = repos.map((r) => {
    const role = r.name === task.fm.repo ? 'репозиторий задачи, текущая папка' : 'общий репозиторий';
    const gitCmd = r.name === task.fm.repo ? '`git log …`, `git show …`' : `\`git -C ${r.folder} log …\`, \`git -C ${r.folder} show …\``;
    return `- ${r.name} — ${role}: ${r.folder} (история: ${gitCmd})`;
  });
  const sectionRules = JUNIOR_SECTIONS.filter((s) => wanted.includes(s.name)).map(
    (s) => `- «${s.name}»: «Нет — <почему>», если ${s.intro.replace(/^«Нет», если /, '')}; иначе все пункты: ${s.labels.map((l) => `**${l}:** <текст>`).join(' ')}`,
  );
  return [
    'Ты оцениваешь задачу из бэклога проекта. Ты только читаешь: файлы (Read, Grep, Glob) и историю git (только git log и git show). Ничего не меняй и не запускай.',
    'Каждая git-команда — отдельным вызовом, без cd, ;, &&, | и циклов: составные команды отклоняются. Другая папка — `git -C <папка> …`; списки файлов и поиск — Glob и Grep.',
    '',
    'Вердикт:',
    '- actual — задачу есть смысл делать: того, что она просит, в коде нет;',
    '- done — похоже, сделано: код уже на месте. Доказательства — файлы и коммиты;',
    '- obsolete — похоже, устарела: модуль удалён, сценарий переписан, смысл потерян. Доказательства — коммит удаления или файл, который всё заменил.',
    'Не уверен между actual и done/obsolete — actual: «похоже…» перепроверяет человек, а ложное «сделано» прячет задачу.',
    'Оценивай по текущей ветке каждой папки (обычно main): сделано — только то, что в её истории. Работа, которая лежит лишь в других ветках (ветка задачи, не влитый PR), — ещё не сделана: вердикт actual, а про ветку скажи в reasoning.',
    '',
    'Доказательство — репозиторий из списка ниже и путь к файлу, существующему в текущей ветке (относительно корня репозитория), или хеш коммита. Коммит из другой ветки тоже доказательство — скрипт отметит его ветку, — но у done и obsolete хотя бы одно доказательство должно быть из текущей ветки. Удалённого файла по пути нет — для него указывай коммит удаления. Каждое доказательство проверяется автоматически; выдуманное — и оценка отбрасывается.',
    '',
    'Репозитории:',
    ...repoLines,
    ...(own ? [] : ['(папки репозитория задачи нет)']),
    '',
    ...(wanted.length > 0
      ? [
          'При вердикте actual допиши разделы для младшего разработчика (только эти):',
          ...sectionRules,
          '«Нет» — утверждение: пиши его, только проверив по коду и сценариям, что изменений нет, и в noReason скажи, что проверил (файлы, поиск). Ложное «Нет» делает опасную задачу «безопасной» для младшего.',
          '«Продуктовые решения» — про то, что видит пользователь: тексты, правила, граничные случаи. Как писать код (какую функцию поменять, вынести ли общее) — не продуктовое решение и сюда не пишется.',
          '«Открытые вопросы» — только поведение для пользователя, которого не решают ни задача, ни нынешний код и которое нельзя выбрать очевидно (по аналогии с соседними командами, по критериям). Выбор реализации, текст справки, порядок полей, догадки «стоит ли заодно…» — не вопросы. Таких вопросов нет — «нет».',
          'Пункты — строками `- **Метка:** текст`, без флажков `- [ ]`.',
          'При done и obsolete разделы не нужны — пустой список.',
        ]
      : ['Разделы для младшего у задачи уже есть — sections пустой список.']),
    '',
    `Задача ${refOf(task)} (файл задачи целиком):`,
    '',
    '````markdown',
    taskText.trimEnd(),
    '````',
  ].join('\n');
}

// ── прогон ───────────────────────────────────────────────────────────────

/** `denied` — команды, в которых агенту отказано: доказательства могли стать слабее, это в отчёт. */
export type AgentOutcome = { answer: unknown; costUsd?: number; denied?: string[] } | { error: string };

/** Запуск агента по одной задаче; в тестах — подделка без сети. */
export type AgentRunner = (job: { task: TaskRecord; prompt: string; repo: CodeRepo }) => Promise<AgentOutcome>;

export interface AssessRun {
  results: AssessResult[];
  failed: Array<{ task: TaskRecord; problems: string[] }>;
  denied: Array<{ task: TaskRecord; commands: string[] }>;
  costUsd: number;
}

/** Оценить задачи агентом по `parallel` за раз и проверить каждый ответ. */
export async function runAssess(
  tasks: readonly TaskRecord[],
  deps: { repos: readonly CodeRepo[]; taskText: (task: TaskRecord) => string; run: AgentRunner; check: EvidenceCheck; parallel: number; onDone?: (task: TaskRecord, ok: boolean) => void },
): Promise<AssessRun> {
  const out: AssessRun = { results: [], failed: [], denied: [], costUsd: 0 };
  const denied = new Map<string, string[]>();
  const byId = new Map<string, AssessResult | { problems: string[] }>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const repo = deps.repos.find((r) => r.name === task.fm.repo);
      if (!repo) {
        byId.set(task.fm.id, { problems: ['нет папки репозитория задачи'] });
        continue;
      }
      const wanted = incompleteSections(task.body);
      const outcome = await deps.run({ task, prompt: assessPrompt(task, deps.taskText(task), deps.repos, wanted), repo });
      if ('error' in outcome) {
        byId.set(task.fm.id, { problems: [outcome.error] });
        deps.onDone?.(task, false);
        continue;
      }
      out.costUsd += outcome.costUsd ?? 0;
      if (outcome.denied && outcome.denied.length > 0) denied.set(task.fm.id, outcome.denied);
      const parsed = AgentAnswerSchema.safeParse(outcome.answer);
      const verdict = parsed.success
        ? verifyAnswer(task, parsed.data, wanted, deps.check)
        : { problems: [`ответ не по схеме: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`] };
      byId.set(task.fm.id, 'result' in verdict ? verdict.result : verdict);
      deps.onDone?.(task, 'result' in verdict);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.parallel, tasks.length)) }, worker));
  // Порядок отчёта — как у задач, а не как закончили агенты.
  for (const task of tasks) {
    const commands = denied.get(task.fm.id);
    if (commands) out.denied.push({ task, commands });
    const r = byId.get(task.fm.id);
    if (!r) continue;
    if ('problems' in r) out.failed.push({ task, problems: r.problems });
    else out.results.push(r);
  }
  return out;
}

// ── отчёт ────────────────────────────────────────────────────────────────

function evidenceLine(e: Evidence): string {
  const branches = e.branches && e.branches.length > 0 ? ` (не в основной ветке: ${e.branches.slice(0, 3).join(', ')}${e.branches.length > 3 ? ` и ещё ${e.branches.length - 3}` : ''})` : '';
  const where = [e.path ? `\`${e.path}\`` : '', e.commit ? `коммит \`${e.commit.slice(0, 10)}\`${branches}` : ''].filter(Boolean).join(', ');
  return `- ${e.repo}: ${where} — ${e.note}`;
}

/** Отчёт сухого прогона для владельца: что агент решил и что будет записано. */
export function formatReport(input: { project: string; created: string; model: string; heads: readonly string[]; run: AssessRun; skipped: AssessSelection['skipped'] }): string {
  const { run } = input;
  const count = (v: AssessVerdict): number => run.results.filter((r) => r.verdict === v).length;
  const lines = [
    `# Оценка задач ${input.project}`,
    '',
    `${input.created}, модель ${input.model}. Код: ${input.heads.join('; ')}.`,
    '',
    `Оценено ${run.results.length}: «Актуальна» — ${count('actual')}, «Похоже, сделана» — ${count('done')}, «Похоже, устарела» — ${count('obsolete')}. Агент не справился — ${run.failed.length}. Пропущено — ${input.skipped.length}.`,
    '',
    'Ничего не записано. Несогласны с задачей — удалите её запись из файла результатов; применить остальное — `--apply <файл результатов>`.',
  ];
  for (const r of run.results) {
    lines.push('', `## ${r.ref} — ${r.title}`, '', `**${VERDICT_LABELS[r.verdict]}.** ${r.reasoning}`);
    if (r.evidence.length > 0) lines.push('', 'Доказательства:', ...r.evidence.map(evidenceLine));
    for (const [name, text] of Object.entries(r.sections)) {
      lines.push('', `### ${name} (будет дописано)`, '', text);
      if (r.noReasons[name]) lines.push('', `_Почему «Нет»:_ ${r.noReasons[name]}`);
    }
  }
  if (run.failed.length > 0) {
    lines.push('', '## Агент не справился', '');
    for (const f of run.failed) lines.push(`- ${refOf(f.task)} — ${f.task.fm.title}: ${f.problems.join('; ')}`);
  }
  if (run.denied.length > 0) {
    lines.push('', '## Агенту отказано в командах', '', 'Доказательства этих задач могли быть слабее: агент не смог выполнить команды.', '');
    for (const d of run.denied) lines.push(`- ${refOf(d.task)} — ${d.task.fm.title}: ${d.commands.map((c) => `\`${c}\``).join(', ')}`);
  }
  if (input.skipped.length > 0) {
    lines.push('', '## Пропущено', '');
    for (const s of input.skipped) lines.push(`- ${refOf(s.task)} — ${s.task.fm.title}: ${s.why}`);
  }
  return `${lines.join('\n')}\n`;
}

// ── применение ───────────────────────────────────────────────────────────

export interface ApplyStep {
  /** Новый текст задачи с дописанными разделами; `null` — текст не меняется. */
  text: string | null;
  /** Комментарий в карточку: вердикт, обоснование, доказательства. */
  comment: string;
}

/**
 * Что записать по одной оценке — или почему её нельзя применить. Всё
 * проверяется до записи: задача на месте, ещё оценивается, постановку не
 * меняли после оценки, разделы после вставки проходят разбор признака.
 */
export function planApply(result: AssessResult, task: TaskRecord | undefined, date: string): ApplyStep | { error: string } {
  if (!task) return { error: 'задачи больше нет' };
  if (!JUNIOR_TYPES.includes(task.fm.type) || !ASSESS_STATUSES.includes(task.fm.status)) return { error: `задача уже в статусе ${task.fm.status} — оценка не применяется` };
  if (String(result.cardId) !== task.fm.tracker) return { error: 'у задачи другая карточка — оцените заново' };
  if (contentHash(task.fm, task.body) !== result.baseHash) return { error: 'задачу изменили после оценки — оцените заново' };

  let text: string | null = null;
  const names = Object.keys(result.sections);
  if (result.verdict === 'actual' && names.length > 0) {
    const unknown = names.filter((n) => !SECTION_NAMES.includes(n));
    if (unknown.length > 0) return { error: `нет таких разделов: ${unknown.join(', ')}` };
    const body = withJuniorSections(task.fm.type, task.body, result.sections);
    const broken = names.flatMap((n) => proposedSectionProblems(n, sectionText(body, n) ?? ''));
    if (broken.length > 0) return { error: `разделы не проходят разбор: ${broken.join('; ')}` };
    text = serializeTaskDocument(task.fm, body);
  }

  const comment = [
    `Оценка скрипта (${date}): «${VERDICT_LABELS[result.verdict]}».${result.verdict === 'actual' ? '' : ' Задачу закрывает человек: перепроверьте и, если не согласны, поменяйте «Оценку» в карточке.'}`,
    '',
    result.reasoning,
    ...(result.evidence.length > 0 ? ['', 'Проверено:', ...result.evidence.map(evidenceLine)] : []),
    ...(names.length > 0 && text !== null ? ['', `Дописаны разделы для младшего: ${names.join(', ')}.`] : []),
    ...Object.entries(result.noReasons).flatMap(([name, why]) => (text !== null ? [`- «Нет» в разделе «${name}»: ${why}`] : [])),
  ].join('\n');
  return { text, comment };
}
