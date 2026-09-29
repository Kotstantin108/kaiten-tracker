/**
 * Ночной бэкап: снимок пишется так, чтобы коммит был только при изменении
 * данных, а пропавшие сущности удалялись — и только в своих папках.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stableJson, writeSnapshot } from '../kaiten-backup.js';

describe('снимок Kaiten на диске', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'kaiten-backup-'));
    dirs.push(d);
    return d;
  };

  it('ключи по алфавиту: тот же объект в другом порядке — тот же текст', () => {
    expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(stableJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }));
  });

  it('повтор без изменений — ни одного файла; пропавшая карточка удаляется, чужие файлы — нет', () => {
    const d = dir();
    const files = new Map<string, unknown>([
      ['company/card-types.json', [{ id: 1 }]],
      ['spaces/5/cards/10.json', { card: { id: 10 }, comments: [] }],
      ['spaces/5/cards/11.json', { card: { id: 11 }, comments: [] }],
    ]);
    expect(writeSnapshot(d, files)).toEqual({ written: 3, removed: 0 });
    expect(writeSnapshot(d, new Map(files))).toEqual({ written: 0, removed: 0 });

    writeFileSync(join(d, 'README.md'), 'бэкап\n');
    mkdirSync(join(d, '.github'));
    writeFileSync(join(d, '.github', 'x.json'), '{}\n');
    files.delete('spaces/5/cards/11.json');
    files.set('spaces/5/cards/10.json', { card: { id: 10, title: 'новое' }, comments: [] });
    expect(writeSnapshot(d, files)).toEqual({ written: 1, removed: 1 });
    expect(existsSync(join(d, 'spaces/5/cards/11.json'))).toBe(false);
    expect(existsSync(join(d, '.github', 'x.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(d, 'spaces/5/cards/10.json'), 'utf8')).card.title).toBe('новое');
  });
});
