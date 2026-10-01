import { describe, expect, it } from 'vitest';

import type { Frontmatter } from '../core/schema.js';
import { verifyRewrite } from '../normalize-tasks.js';

const FM: Frontmatter = {
  id: '01K5ZQ3R8F2K9M4N7P0T5V8W2X',
  title: 'Починить экспорт',
  summary: 'Экспорт пустого списка падает.',
  type: 'tech',
  status: 'backlog',
  repo: 'app',
  created: '2026-09-01',
  created_by: 'alice',
  updated: '2026-09-01',
};
const OLD = '## Мотивация (WHY)\n\nЭкспорт падает.\n\n## Что (WHAT)\n\n- [x] Разобрали причину\n- [ ] Починить экспорт\n';

describe('дозаполнение постановки: проверка ответа модели', () => {
  it('переименованные разделы и новый критерий — принято, добавленное видно', () => {
    const next = '## Зачем\n\nЭкспорт падает.\n\n## Что сделать\n\n- [x] Разобрали причину\n- [ ] Починить экспорт\n\n## Критерии готовности\n\n- [ ] Пустой список выгружается без ошибки\n';
    const v = verifyRewrite('tech', FM, OLD, next);
    expect(v.violations).toEqual([]);
    expect(v.added).toEqual(['- [ ] Пустой список выгружается без ошибки']);
  });

  it('переписанная строка и снятая отметка — нарушения', () => {
    const next = '## Зачем\n\nЭкспорт иногда падает.\n\n## Что сделать\n\n- [ ] Разобрали причину\n- [ ] Починить экспорт\n\n## Критерии готовности\n\nКритериев нет: общая задача\n';
    const v = verifyRewrite('tech', FM, OLD, next);
    expect(v.violations[0]).toContain('потеряны или изменены строки старого текста (2)');
    expect(v.violations).toContain('отмеченных пунктов было 1, стало 0');
  });

  it('постановка всё ещё не проходит проверку kaiten new — нарушение', () => {
    const v = verifyRewrite('tech', FM, OLD, OLD);
    expect(v.violations).toContain('нет раздела «Зачем»');
  });
});
