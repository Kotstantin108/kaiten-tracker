/**
 * Подключение репозитория кода и проверка установки — чистая часть.
 */
import { describe, expect, it } from 'vitest';

import { planConnect, RULES_END, RULES_START, rulesBlock, rulesState, skillState, withRulesBlock } from '../core/repo-connect.js';
import { formatChecks } from '../kaiten-doctor.js';

const SKILL = '---\nname: kaiten\n---\n\n# Задачи проекта\n';
const base = { tasks: 'https://example.com/acme/acme-tasks.git', repo: 'acme-app', push: 'branch' as const, toolSkill: SKILL, rulesFile: 'CLAUDE.md' };

describe('подключение репозитория', () => {
  it('пустой репозиторий: файл проекта, скилл и файл правил с блоком', () => {
    const changes = planConnect({ ...base, current: { projectFile: null, skill: null, rules: null } });
    expect(changes.map((c) => c.path)).toEqual(['.kaiten', '.claude/skills/kaiten/SKILL.md', 'CLAUDE.md']);
    expect(changes[0].text).toBe('tasks: https://example.com/acme/acme-tasks.git\nrepo: acme-app\n');
    expect(changes[2].text.startsWith(RULES_START)).toBe(true);
    expect(changes[2].text).toContain('Перед любой правкой кода — скилл kaiten');
    expect(changes[2].text).toContain('git push -u origin');
  });

  it('повторный запуск ничего не меняет; переводы строк Windows — не отличие', () => {
    const first = planConnect({ ...base, current: { projectFile: null, skill: null, rules: '# Проект\n\nТекст.\n' } });
    const current = { projectFile: first[0].text.replace(/\n/g, '\r\n'), skill: first[1].text.replace(/\n/g, '\r\n'), rules: first[2].text.replace(/\n/g, '\r\n') };
    expect(planConnect({ ...base, current })).toEqual([]);
  });

  it('блок правил дописывается в конец, а при смене правила заменяется на месте — текст вокруг цел', () => {
    const before = '# Проект\n\nСвои правила.\n';
    const added = withRulesBlock(before, rulesBlock('branch'));
    expect(added.startsWith('# Проект\n\nСвои правила.\n\n' + RULES_START)).toBe(true);
    const withTail = `${added}\n## Ещё раздел\n\nХвост.\n`;
    const changed = withRulesBlock(withTail, rulesBlock('none'));
    expect(changed).toContain('Ветку не пушьте');
    expect(changed).not.toContain('git push -u origin');
    expect(changed.match(new RegExp(RULES_END, 'g'))).toHaveLength(1);
    expect(changed.endsWith('## Ещё раздел\n\nХвост.\n')).toBe(true);
  });

  it('устаревший скилл и чужой файл проекта — в плане, с объяснением', () => {
    const changes = planConnect({ ...base, current: { projectFile: 'tasks: https://example.com/other/other-tasks.git\nrepo: other-site\n', skill: 'старый текст', rules: withRulesBlock(null, rulesBlock('branch')) } });
    expect(changes.map((c) => [c.path, c.what])).toEqual([
      ['.kaiten', 'файл проекта — другой проект или продукт, заменяется'],
      ['.claude/skills/kaiten/SKILL.md', 'скилл — устарел, обновляется'],
    ]);
  });

  it('состояние скилла и правил — для kaiten doctor', () => {
    expect(skillState(SKILL, null)).toBe('missing');
    expect(skillState(SKILL, 'другое')).toBe('stale');
    expect(skillState(SKILL, SKILL.replace(/\n/g, '\r\n'))).toBe('fresh');
    expect(rulesState(null)).toBe('missing');
    expect(rulesState('# Проект\n')).toBe('missing');
    expect(rulesState(withRulesBlock('# Проект\n', rulesBlock('pr')))).toBe('fresh');
    expect(rulesState(`${RULES_START}\nстарые правила\n${RULES_END}\n`)).toBe('stale');
  });
});

describe('kaiten doctor: вывод', () => {
  it('у каждой проблемы — что сделать; итог по худшему', () => {
    expect(formatChecks([{ level: 'ok', what: 'git есть' }]).at(-1)).toBe('Всё готово.');
    const lines = formatChecks([
      { level: 'ok', what: 'git есть' },
      { level: 'warn', what: 'скилл устарел', fix: 'обновить' },
      { level: 'fail', what: 'задач нет', fix: 'kaiten pull' },
    ]);
    expect(lines).toEqual(['✓ git есть', '! скилл устарел', '    → обновить', '✗ задач нет', '    → kaiten pull', '', 'Не готово: исправить 1, предупреждений 1.']);
    expect(formatChecks([{ level: 'warn', what: 'x', fix: 'y' }]).at(-1)).toBe('Работать можно; предупреждений 1.');
  });
});
