/**
 * Хостинг репозитория — GitHub или GitLab: адреса, ссылки в карточках,
 * сообщения об отказе в доступе, правило про ветку, отказ на своём сервере
 * без названного хостинга. Сети нет.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { projectFromTasksRepo } from '../config.js';
import { hostingOf, noAccessMessage, noLoginMessage, parseRepoAddress, repoWebBase, unknownHost } from '../core/hosting.js';
import { planConnect, rulesBlock, rulesState, withRulesBlock } from '../core/repo-connect.js';
import { storeMessage } from '../kaiten-cli.js';
import { loadOwnerProject } from '../owner-project.js';
import { classify } from '../task-store.js';

const CONFIG = {
  project: 'acme',
  title: 'Acme',
  kaiten: { space: 'Acme', board: 'Задачи', repoField: 'Репозиторий Acme' },
  repos: [{ name: 'acme-app', label: 'Acme-app' }],
};

describe('адрес репозитория', () => {
  it('три вида адреса, вложенные группы, порт SSH сайту не нужен', () => {
    expect(parseRepoAddress('git@gitlab.example.com:group/sub/acme-tasks.git')).toEqual({ host: 'gitlab.example.com', origin: 'https://gitlab.example.com', path: 'group/sub/acme-tasks' });
    expect(parseRepoAddress('https://gitlab.example.com/group/sub/acme-tasks.git')).toEqual({ host: 'gitlab.example.com', origin: 'https://gitlab.example.com', path: 'group/sub/acme-tasks' });
    expect(parseRepoAddress('ssh://git@gitlab.example.com:2222/group/acme-tasks.git')).toEqual({ host: 'gitlab.example.com', origin: 'https://gitlab.example.com', path: 'group/acme-tasks' });
    // Логин и токен в адресе HTTPS в ссылки не попадают; порт сайта — остаётся.
    expect(parseRepoAddress('https://alice:secret@GitLab.Example.com:8443/group/acme-tasks/')).toEqual({ host: 'gitlab.example.com', origin: 'https://gitlab.example.com:8443', path: 'group/acme-tasks' });
  });

  it('папка на диске — не сервер', () => {
    for (const local of ['C:/tmp/remote.git', 'C:\\tmp\\remote.git', '/srv/git/acme-tasks.git', '../acme-tasks', 'file:///C:/tmp/remote.git', '', undefined]) {
      expect(parseRepoAddress(local)).toBeNull();
    }
  });

  it('github.com и gitlab.com узнаются по адресу, свой сервер — названный владельцем', () => {
    const own = parseRepoAddress('git@git.example.com:group/acme-tasks.git');
    expect(own && hostingOf(own)).toBeNull();
    expect(own && hostingOf(own, 'gitlab')).toBe('gitlab');
    const known = parseRepoAddress('https://gitlab.com/group/acme-tasks.git');
    expect(known && hostingOf(known)).toBe('gitlab');
    // Узнанный по адресу сильнее названного: опечатка в kaiten.json не ломает ссылки.
    expect(known && hostingOf(known, 'github')).toBe('gitlab');
    expect(unknownHost('git@git.example.com:group/acme-tasks.git')).toBe('git.example.com');
    expect(unknownHost('git@git.example.com:group/acme-tasks.git', 'gitlab')).toBeNull();
    expect(unknownHost('https://github.com/org/acme-tasks.git')).toBeNull();
    expect(unknownHost('C:/tmp/remote.git')).toBeNull();
    expect(unknownHost(undefined)).toBeNull();
  });
});

describe('база ссылок на файлы', () => {
  /** Как база считалась до GitLab: от неё зависит хеш «что получила карточка». */
  const before = (url: string): string | null => {
    const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
    const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
    return https ? `https://github.com/${https[1]}/${https[2]}` : null;
  };

  it('для адресов GitHub — прежняя буква в букву: карточки существующих проектов не перерисовываются', () => {
    for (const url of ['git@github.com:org/acme-tasks.git', 'git@github.com:org/acme-tasks', 'https://github.com/org/acme-tasks.git', 'https://github.com/org/acme-tasks', 'https://github.com/org/acme-tasks/']) {
      expect(before(url)).not.toBeNull();
      expect(repoWebBase(url)).toBe(before(url));
      // Поле хостинга, дописанное в kaiten.json «для ясности», базу не меняет.
      expect(repoWebBase(url, 'github')).toBe(before(url));
    }
  });

  it('GitLab: файл открывается по /-/blob/', () => {
    expect(repoWebBase('https://gitlab.com/group/acme-tasks.git')).toBe('https://gitlab.com/group/acme-tasks/-');
    expect(repoWebBase('git@gitlab.com:group/sub/acme-tasks.git')).toBe('https://gitlab.com/group/sub/acme-tasks/-');
    for (const url of ['git@gitlab.example.com:group/sub/acme-tasks.git', 'https://gitlab.example.com/group/sub/acme-tasks.git', 'ssh://git@gitlab.example.com:2222/group/sub/acme-tasks.git']) {
      expect(repoWebBase(url, 'gitlab')).toBe('https://gitlab.example.com/group/sub/acme-tasks/-');
    }
  });

  it('свой сервер GitHub — как github.com, только домен другой', () => {
    expect(repoWebBase('git@github.example.com:org/acme-tasks.git', 'github')).toBe('https://github.example.com/org/acme-tasks');
  });

  it('ссылок нет: папка на диске, домен без названного хостинга, адрес без владельца', () => {
    expect(repoWebBase('C:/tmp/remote.git')).toBeNull();
    expect(repoWebBase(undefined)).toBeNull();
    expect(repoWebBase('git@gitlab.example.com:group/acme-tasks.git')).toBeNull();
    expect(repoWebBase('https://gitlab.com/acme-tasks.git')).toBeNull();
  });
});

describe('kaiten.json: хостинг репозитория задач', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kaiten-hosting-test-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const config = (tasksRepo: Record<string, string>): string => {
    const path = join(tmp, `${Object.values(tasksRepo).join('-').replace(/[^a-z0-9]+/gi, '-')}.json`);
    writeFileSync(path, JSON.stringify({ ...CONFIG, tasksRepo }));
    return path;
  };

  it('поле доходит до проекта; значение — только github или gitlab', () => {
    const text = JSON.stringify({ ...CONFIG, tasksRepo: { name: 'acme-tasks', hosting: 'gitlab' } });
    expect(projectFromTasksRepo(text, 'git@gitlab.example.com:group/acme-tasks.git').project.tasksRepo).toEqual({
      name: 'acme-tasks',
      url: 'git@gitlab.example.com:group/acme-tasks.git',
      hosting: 'gitlab',
    });
    expect(() => projectFromTasksRepo(JSON.stringify({ ...CONFIG, tasksRepo: { name: 'acme-tasks', hosting: 'bitbucket' } }))).toThrow(/tasksRepo\.hosting/);
  });

  it('свой сервер без поля — скрипты владельца отказывают и говорят, что указать', () => {
    const path = config({ name: 'acme-tasks', url: 'git@gitlab.example.com:group/acme-tasks.git' });
    expect(() => loadOwnerProject(['--config', path])).toThrow('Репозиторий задач лежит на gitlab.example.com — по адресу не понять, GitHub это или GitLab. Укажите в kaiten.json: "tasksRepo": { …, "hosting": "github" | "gitlab" }');
  });

  it('свой сервер с полем, gitlab.com и github.com — без отказа', () => {
    expect(loadOwnerProject(['--config', config({ name: 'acme-tasks', url: 'git@gitlab.example.com:group/acme-tasks.git', hosting: 'gitlab' })]).loaded.project.tasksRepo?.hosting).toBe('gitlab');
    expect(loadOwnerProject(['--config', config({ name: 'acme-tasks', url: 'https://gitlab.com/group/acme-tasks.git' })]).loaded.key).toBe('acme');
    expect(loadOwnerProject(['--config', config({ name: 'acme-tasks', url: 'https://github.com/org/acme-tasks.git' })]).loaded.key).toBe('acme');
  });
});

describe('отказ в доступе к задачам', () => {
  it('ответы GitLab: нет входа — не «нет доступа», нет в проекте — не «не найдено»', () => {
    expect(classify("fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled")).toBe('no-login');
    expect(
      classify(
        "remote: HTTP Basic: Access denied. The provided password or token is incorrect or your account has 2FA enabled and you must use a personal access token instead of a password.\nfatal: Authentication failed for 'https://gitlab.example.com/group/acme-tasks.git/'",
      ),
    ).toBe('no-login');
    expect(classify('remote: HTTP Basic: Access denied\nfatal: unable to access')).toBe('no-login');
    expect(classify('git@gitlab.com: Permission denied (publickey,keyboard-interactive).\nfatal: Could not read from remote repository.')).toBe('no-login');
    expect(classify("remote: The project you were looking for could not be found or you don't have permission to view it.\nfatal: repository 'https://gitlab.com/group/acme-tasks.git/' not found")).toBe('no-access');
    expect(classify("remote: ERROR: The project you were looking for could not be found or you don't have permission to view it.\nfatal: Could not read from remote repository.")).toBe('no-access');
    expect(classify('remote: GitLab: You are not allowed to push code to this project.\nfatal: Could not read from remote repository.')).toBe('no-access');
    // Защищённая ветка — правила хранилища, а не доступ человека.
    expect(classify('remote: GitLab: You are not allowed to push code to protected branches on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)')).toBe('refused');
  });

  it('GitHub — прежние тексты', () => {
    const where = { url: 'https://github.com/org/acme-tasks.git' };
    expect(storeMessage('no-access', where)).toBe('Нет доступа к задачам проекта. Попросите владельца проекта добавить вас в команду проекта на GitHub.');
    expect(storeMessage('no-login', where)).toBe(
      'Git на этой машине не может войти в GitHub: для адреса задач нет логина или ключа. Это настройка машины, а не доступ к проекту. ' +
        'Войдите в GitHub для HTTPS (например, gh auth login) или, если у вас настроен SSH-ключ, перенаправьте HTTPS на SSH: ' +
        'git config --global url."git@github.com:".insteadOf "https://github.com/". Затем повторите команду.',
    );
  });

  it('GitLab — хостинг, домен и свой совет по входу; пути репозитория в тексте нет', () => {
    const own = { url: 'https://gitlab.example.com/group/acme-tasks.git', hosting: 'gitlab' as const };
    expect(noAccessMessage(own)).toBe('Нет доступа к задачам проекта. Попросите владельца проекта добавить вас в проект на GitLab (gitlab.example.com).');
    expect(noLoginMessage(own)).toBe(
      'Git на этой машине не может войти в GitLab (gitlab.example.com): для адреса задач нет логина или ключа. Это настройка машины, а не доступ к проекту. ' +
        'Войдите в GitLab для HTTPS (например, glab auth login --hostname gitlab.example.com; подойдёт и токен доступа вместо пароля) или, если у вас настроен SSH-ключ, перенаправьте HTTPS на SSH: ' +
        'git config --global url."git@gitlab.example.com:".insteadOf "https://gitlab.example.com/". Затем повторите команду.',
    );
    const com = { url: 'git@gitlab.com:group/acme-tasks.git' };
    expect(noAccessMessage(com)).toContain('на GitLab (gitlab.com)');
    expect(noLoginMessage(com)).toContain('(например, glab auth login; подойдёт');
    for (const text of [noAccessMessage(own), noLoginMessage(own), noAccessMessage(com), noLoginMessage(com)]) expect(text).not.toContain('acme-tasks');
  });

  it('до первой загрузки хостинг своего сервера неизвестен — сообщение называет домен', () => {
    const where = { url: 'git@git.example.com:group/acme-tasks.git' };
    expect(noAccessMessage(where)).toBe('Нет доступа к задачам проекта. Попросите владельца проекта дать вам доступ к задачам на git.example.com.');
    expect(noLoginMessage(where)).toContain('не может войти на git.example.com:');
    expect(noLoginMessage(where)).toContain('url."git@git.example.com:".insteadOf "https://git.example.com/"');
    expect(noLoginMessage(where)).not.toMatch(/GitHub|GitLab|gh auth|glab/);
  });

  it('адреса нет или это папка — без домена и без чужого хостинга', () => {
    expect(storeMessage('no-access')).toBe('Нет доступа к задачам проекта. Попросите владельца проекта дать вам доступ к задачам.');
    expect(storeMessage('no-login', { url: 'C:/tmp/remote.git' })).not.toMatch(/GitHub|GitLab/);
  });
});

describe('правило про ветку', () => {
  const SKILL = '---\nname: kaiten\n---\n';
  const input = { tasks: 'https://gitlab.com/group/acme-tasks.git', repo: 'acme-app', toolSkill: SKILL, rulesFile: 'CLAUDE.md', current: { projectFile: null, skill: null, rules: null } };

  it('GitHub — блок прежний буква в букву: подключённые репозитории doctor не называет устаревшими', () => {
    const block = (rule: string): string =>
      [
        '<!-- kaiten:start — блок ведёт kaiten-tracker, правки руками сотрутся -->',
        '## Задачи проекта',
        '',
        '- Задачи проекта — через команду `kaiten` (скилл kaiten); папки `tasks/` в репозитории нет.',
        '- Перед любой правкой кода — скилл kaiten: найдите задачу или спросите, заводить ли её.',
        `- ${rule}`,
        '<!-- kaiten:end -->',
      ].join('\n');
    expect(rulesBlock('none')).toBe(block('Работа по задаче — коммитами в её ветке. Ветку не пушьте и PR не открывайте: это делает человек после ревью.'));
    expect(rulesBlock('branch')).toBe(block('Работа по задаче — коммитами в её ветке. Перед `kaiten review` отправьте ветку: `git push -u origin <ветка>`. PR не открывайте — его открывает человек.'));
    expect(rulesBlock('pr')).toBe(
      block('Работа по задаче — коммитами в её ветке. Перед `kaiten review` отправьте ветку и откройте PR в основную ветку (`gh pr create`), ссылку на него — в `kaiten review --note`. Сливает PR человек.'),
    );
    expect(rulesBlock('pr', 'github')).toBe(rulesBlock('pr'));
  });

  it('GitLab — merge request и glab, ни PR, ни gh', () => {
    const rules = planConnect({ ...input, push: 'pr', hosting: 'gitlab' }).find((c) => c.path === 'CLAUDE.md')?.text ?? '';
    expect(rules).toContain('откройте merge request в основную ветку (`glab mr create`), ссылку на него — в `kaiten review --note`');
    for (const push of ['none', 'branch', 'pr'] as const) {
      expect(rulesBlock(push, 'gitlab')).toContain('erge request');
      expect(rulesBlock(push, 'gitlab')).not.toMatch(/\bPR\b|\bgh\b/);
    }
  });

  it('блок любого хостинга — свежий; смена хостинга заменяет блок на месте', () => {
    for (const push of ['none', 'branch', 'pr'] as const) {
      expect(rulesState(withRulesBlock('# Проект\n', rulesBlock(push, 'gitlab')))).toBe('fresh');
      expect(rulesState(withRulesBlock('# Проект\n', rulesBlock(push, 'github')))).toBe('fresh');
    }
    const onGithub = withRulesBlock('# Проект\n', rulesBlock('pr', 'github'));
    const moved = planConnect({ ...input, push: 'pr', hosting: 'gitlab', current: { projectFile: null, skill: null, rules: onGithub } }).find((c) => c.path === 'CLAUDE.md');
    expect(moved?.what).toBe('блок правил kaiten — обновляется');
    expect(moved?.text).toContain('glab mr create');
    expect(moved?.text).not.toContain('gh pr create');
  });
});
