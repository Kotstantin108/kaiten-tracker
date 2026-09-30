/**
 * Подключение репозитория кода к kaiten — чистая часть: что должно лежать в
 * репозитории и что в нём поменять. Пользуются скрипт владельца
 * `npm run connect-repo` (пишет) и `kaiten doctor` (только проверяет).
 *
 * В репозитории кода три вещи:
 *   · `.kaiten` — проект и продукт (две строки YAML);
 *   · `.claude/skills/kaiten/SKILL.md` — копия скилла из этого репозитория:
 *     скилл правится здесь, а в проектах устаревает, поэтому сверяется;
 *   · блок правил в `CLAUDE.md` (или `AGENTS.md`) между метками — чтобы
 *     повторный запуск обновлял его, а не дописывал второй раз. Блок нужен:
 *     без строки «перед любой правкой кода — скилл kaiten» агент при
 *     поручении словами к задачам не идёт (испытание 30.09.2026).
 */

export const PROJECT_FILE_PATH = '.kaiten';
export const SKILL_PATH = '.claude/skills/kaiten/SKILL.md';

export const RULES_START = '<!-- kaiten:start — блок ведёт kaiten-tracker, правки руками сотрутся -->';
export const RULES_END = '<!-- kaiten:end -->';

/** Что делать с веткой перед ревью — решает владелец проекта. */
export const PUSH_POLICIES = ['none', 'branch', 'pr'] as const;
export type PushPolicy = (typeof PUSH_POLICIES)[number];

const PUSH_RULE: Record<PushPolicy, string> = {
  none: 'Работа по задаче — коммитами в её ветке. Ветку не пушьте и PR не открывайте: это делает человек после ревью.',
  branch: 'Работа по задаче — коммитами в её ветке. Перед `kaiten review` отправьте ветку: `git push -u origin <ветка>`. PR не открывайте — его открывает человек.',
  pr: 'Работа по задаче — коммитами в её ветке. Перед `kaiten review` отправьте ветку и откройте PR в основную ветку (`gh pr create`), ссылку на него — в `kaiten review --note`. Сливает PR человек.',
};

export function rulesBlock(push: PushPolicy): string {
  return [
    RULES_START,
    '## Задачи проекта',
    '',
    '- Задачи проекта — через команду `kaiten` (скилл kaiten); папки `tasks/` в репозитории нет.',
    '- Перед любой правкой кода — скилл kaiten: найдите задачу или спросите, заводить ли её.',
    `- ${PUSH_RULE[push]}`,
    RULES_END,
  ].join('\n');
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/** Файл правил с блоком kaiten: блок заменяется на месте, а если его нет — дописывается в конец. */
export function withRulesBlock(text: string | null, block: string): string {
  const current = lf(text ?? '');
  const start = current.indexOf(RULES_START);
  const end = current.indexOf(RULES_END);
  if (start !== -1 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + RULES_END.length)}`;
  const head = current.trimEnd();
  return `${head ? `${head}\n\n` : ''}${block}\n`;
}

export type SkillState = 'fresh' | 'stale' | 'missing';

/** Копия скилла в репозитории против скилла инструмента; переводы строк не различаются. */
export function skillState(toolSkill: string, repoSkill: string | null): SkillState {
  if (repoSkill === null) return 'missing';
  return lf(repoSkill).trim() === lf(toolSkill).trim() ? 'fresh' : 'stale';
}

export type RulesState = 'fresh' | 'stale' | 'missing';

/** Есть ли в файле правил блок kaiten и совпадает ли он с каким-нибудь из действующих вариантов. */
export function rulesState(text: string | null): RulesState {
  if (text === null) return 'missing';
  const current = lf(text);
  const start = current.indexOf(RULES_START);
  const end = current.indexOf(RULES_END);
  if (start === -1 || end < start) return 'missing';
  const block = current.slice(start, end + RULES_END.length);
  return PUSH_POLICIES.some((p) => rulesBlock(p) === block) ? 'fresh' : 'stale';
}

export interface ConnectInput {
  project: string;
  repo: string;
  push: PushPolicy;
  /** Скилл инструмента — то, что должно лежать в репозитории. */
  toolSkill: string;
  /** Имя файла правил и что в репозитории сейчас (`null` — файла нет). */
  rulesFile: string;
  current: { projectFile: string | null; skill: string | null; rules: string | null };
}

export interface ConnectChange {
  path: string;
  text: string;
  /** Что это — словами для плана. */
  what: string;
}

/** Что записать в репозиторий; пустой список — всё уже на месте. */
export function planConnect(input: ConnectInput): ConnectChange[] {
  const changes: ConnectChange[] = [];
  const projectFile = `project: ${input.project}\nrepo: ${input.repo}\n`;
  if (lf(input.current.projectFile ?? '') !== projectFile) {
    changes.push({ path: PROJECT_FILE_PATH, text: projectFile, what: input.current.projectFile === null ? 'файл проекта — новый' : 'файл проекта — другой проект или продукт, заменяется' });
  }
  const skill = skillState(input.toolSkill, input.current.skill);
  if (skill !== 'fresh') changes.push({ path: SKILL_PATH, text: lf(input.toolSkill), what: skill === 'missing' ? 'скилл — новый' : 'скилл — устарел, обновляется' });
  const rules = withRulesBlock(input.current.rules, rulesBlock(input.push));
  if (rules !== lf(input.current.rules ?? '')) {
    const state = rulesState(input.current.rules);
    changes.push({
      path: input.rulesFile,
      text: rules,
      what: input.current.rules === null ? 'файл правил — новый, с блоком kaiten' : state === 'missing' ? 'блок правил kaiten — дописывается в конец' : 'блок правил kaiten — обновляется',
    });
  }
  return changes;
}
