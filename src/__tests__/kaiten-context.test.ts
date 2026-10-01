/**
 * Файл проекта `.kaiten` и настройки kaiten: без файла репозиторий не
 * подключён; настройки не выдают токен в ошибках; копия по умолчанию выключена.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findProjectFile, loadSettings, localCopyDir, parseProjectFile, PROJECT_FILE, readProjectFile, SettingsError } from '../kaiten-context.js';

const tmp = mkdtempSync(join(tmpdir(), 'kaiten-context-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('файл проекта', () => {
  it('ищется вверх от текущей папки', () => {
    const repo = join(tmp, 'repo');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(repo, PROJECT_FILE), 'tasks: https://example.com/acme/acme-tasks.git\nrepo: acme-app\n');
    expect(findProjectFile(join(repo, 'src', 'deep'))).toBe(join(repo, PROJECT_FILE));
    expect(readProjectFile(join(repo, 'src'))).toEqual({ file: { tasks: 'https://example.com/acme/acme-tasks.git', repo: 'acme-app' } });
  });

  it('нет файла — не подключён', () => {
    const bare = join(tmp, 'no-project');
    mkdirSync(bare);
    // Вверх по дереву до корня диска — лишь бы там не оказалось чужого .kaiten.
    expect(findProjectFile(bare) === null || !findProjectFile(bare)?.startsWith(tmp)).toBe(true);
  });

  it('обе строки обязательны, лишнего не бывает', () => {
    expect(parseProjectFile('tasks: https://example.com/acme/acme-tasks.git\n')).toEqual({ error: 'repo: обязательное поле' });
    expect('error' in parseProjectFile('tasks: https://example.com/acme/acme-tasks.git\nrepo: x\nextra: 1\n')).toBe(true);
    expect('error' in parseProjectFile('tasks: [\n')).toBe(true);
    // Старый вид — с подсказкой, что поменять.
    expect(parseProjectFile('project: acme\nrepo: acme-app\n')).toEqual({ error: 'старый вид файла: вместо «project: …» нужна строка «tasks: <адрес репозитория задач>»' });
    expect('error' in parseProjectFile('')).toBe(true);
  });
});

describe('настройки', () => {
  const write = (name: string, value: unknown): string => {
    const path = join(tmp, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };

  it('нет файла — копия выключена, входа в Kaiten нет', () => {
    const settings = loadSettings(join(tmp, 'missing.json'));
    expect(settings.kaiten).toBeUndefined();
    expect(localCopyDir(settings, 'acme')).toBeNull();
  });

  it('копия — в <dir>/<проект>, только когда включена', () => {
    const on = loadSettings(write('on.json', { localCopy: { enabled: true, dir: join(tmp, 'tasks') } }));
    expect(localCopyDir(on, 'acme')).toBe(join(tmp, 'tasks', 'acme'));
    const off = loadSettings(write('off.json', { localCopy: { enabled: false, dir: join(tmp, 'tasks') } }));
    expect(localCopyDir(off, 'acme')).toBeNull();
    expect(() => loadSettings(write('no-dir.json', { localCopy: { enabled: true } }))).toThrow(/dir/);
  });

  it('ошибка в настройках не выводит токен', () => {
    const secret = 'secret-token-value-123';
    const path = write('bad.json', { kaiten: { domain: 'example.kaiten.ru', token: secret, extra: secret } });
    expect(() => loadSettings(path)).toThrow(SettingsError);
    try {
      loadSettings(path);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('extra');
    }
    const typed = write('typed.json', { kaiten: { domain: 'x', token: 12345 } });
    try {
      loadSettings(typed);
    } catch (error) {
      expect((error as Error).message).not.toContain('12345');
    }
    expect(() => loadSettings(write('broken.json', `{"kaiten": {"token": "${secret}"`))).toThrow(/JSON/);
  });

  it('вход в Kaiten читается', () => {
    const settings = loadSettings(write('login.json', { kaiten: { domain: 'example.kaiten.ru', token: 't' } }));
    expect(settings.kaiten).toEqual({ domain: 'example.kaiten.ru', token: 't' });
  });
});
