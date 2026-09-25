/**
 * Временный ридер формата globex. Проверяется то, что даст дубли или
 * неверный статус: ключ без папки, папка done/ сильнее строки статуса.
 */
import { describe, expect, it } from 'vitest';

import { numberedStatus, numberedTitle, parseNumberedTask } from '../numbered-source.js';

const repo = { name: 'globex-site', path: '/x', url: 'https://github.com/acme-org/globex-site', branch: 'main' };

describe('parseNumberedTask', () => {
  const text = ['# 0010 — Финал: данные, ассеты (Фаза 6)', '', '**Статус:** todo', '**Зависит от:** 0003–0009', '', '## Критерии', '', '- [ ] Прод-деплой'].join('\n');

  it('название без номера и фазы, статус из строки, строка статуса убрана из тела', () => {
    const t = parseNumberedTask(repo, '0010-final.md', text, false);
    expect(t?.title).toBe('Финал: данные, ассеты');
    expect(t?.status).toBe('backlog');
    expect(t?.body.startsWith('**Зависит от:**')).toBe(true);
    expect(t?.body).not.toContain('**Статус:**');
    expect(t?.meta.priority).toBeNull();
    expect(t?.sourceFile).toBe('tasks/0010-final.md');
  });

  it('ключ не зависит от папки: переезд в done/ не даёт новую карточку', () => {
    const active = parseNumberedTask(repo, '0010-final.md', text, false);
    const done = parseNumberedTask(repo, '0010-final.md', text, true);
    expect(active?.externalId).toBe('globex-site:0010-final');
    expect(done?.externalId).toBe(active?.externalId);
    expect(done?.status).toBe('done');
  });

  it('чужие файлы (LOG.md) пропускаются', () => {
    expect(parseNumberedTask(repo, 'LOG.md', text, false)).toBeNull();
  });
});

describe('мелочи', () => {
  it('статусы globex', () => {
    expect(numberedStatus('in progress', false)).toBe('in-progress');
    expect(numberedStatus('blocked', false)).toBe('blocked');
    expect(numberedStatus('todo', true)).toBe('done');
    expect(numberedStatus(null, false)).toBe('backlog');
  });

  it('название без фазы и с другим тире', () => {
    expect(numberedTitle('# 0052 - Раскрытие остатка', 'x')).toBe('Раскрытие остатка');
    expect(numberedTitle('', 'fallback')).toBe('fallback');
  });
});
