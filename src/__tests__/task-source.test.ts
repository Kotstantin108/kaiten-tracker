/**
 * Тесты разбора задач. Ошибка здесь тихо портит заливку: не тот статус, не тот
 * ключ идемпотентности — и вместо обновления появится дубль карточки.
 */
import { describe, expect, it } from 'vitest';

import {
  externalIdFromFolder,
  normalizeRemoteUrl,
  parentExternalIdFromHeader,
  parseFolderName,
  parseTaskFile,
  rewriteRelativeLinks,
  selectScope,
  statusFromPath,
  type TaskFile,
} from '../task-source.js';

const REPO = 'acme-app';

const task = (over: Partial<TaskFile> & Pick<TaskFile, 'externalId'>): TaskFile => ({
  repoName: REPO,
  repoUrl: 'https://github.com/acme-org/acme-app',
  branch: 'main',
  dir: `tasks/backlog/stories/${over.externalId}`,
  folderName: over.externalId,
  meta: { date: '20260916', type: 'story', priority: 'p1', slug: over.externalId },
  status: 'backlog',
  bucketMonth: null,
  title: over.externalId,
  header: { slug: null, title: null, type: null, priority: null, status: null, parent: null, created: null, related: [] },
  body: '',
  parentExternalId: null,
  nested: false,
  hasLog: false,
  attachments: [],
  ...over,
});

describe('parseFolderName', () => {
  it('разбирает канонические имена', () => {
    expect(parseFolderName('20260916_spike_p1_tracker-pilot-kaiten')).toEqual({
      date: '20260916',
      type: 'spike',
      priority: 'p1',
      slug: 'tracker-pilot-kaiten',
    });
  });

  it('оставляет суффиксы внутри slug', () => {
    expect(parseFolderName('20260425_story_pn_share-links_superseded')?.slug).toBe('share-links_superseded');
    expect(parseFolderName('20260416_epic_p2_checkout_initial')?.slug).toBe('checkout_initial');
  });

  it('отвергает чужие имена и неизвестные типы', () => {
    expect(parseFolderName('2026-09')).toBeNull();
    expect(parseFolderName('backlog')).toBeNull();
    expect(parseFolderName('20260916_chore_p1_slug')).toBeNull();
    expect(parseFolderName('20260916_story_p9_slug')).toBeNull();
  });
});

describe('externalIdFromFolder', () => {
  it('выбрасывает тип и приоритет: их меняет триаж', () => {
    expect(externalIdFromFolder('20260916_spike_p1_tracker-pilot-kaiten', REPO)).toBe(
      'acme-app:20260916_tracker-pilot-kaiten',
    );
    // inbox → backlog/technical меняет и приоритет, и тип, а ключ обязан выжить
    expect(externalIdFromFolder('20260425_tech_pn_litellm', REPO)).toBe('acme-app:20260425_litellm');
    expect(externalIdFromFolder('20260425_story_p2_litellm', REPO)).toBe('acme-app:20260425_litellm');
  });

  it('разводит одинаковые задачи разных репозиториев', () => {
    expect(externalIdFromFolder('20260916_story_p1_x', 'globex-site')).not.toBe(
      externalIdFromFolder('20260916_story_p1_x', REPO),
    );
  });
});

describe('statusFromPath', () => {
  it('выводит статус из бакета', () => {
    expect(statusFromPath('tasks/backlog/inbox/20260425_tech_pn_litellm')).toEqual({ status: 'inbox', bucketMonth: null });
    expect(statusFromPath('tasks/backlog/bugs/20260721_bug_p0_x')).toEqual({ status: 'backlog', bucketMonth: null });
    expect(statusFromPath('tasks/in-progress/20260820_bug_p1_x')).toEqual({ status: 'in-progress', bucketMonth: null });
    expect(statusFromPath('tasks/done/2026-09/20260914_epic_p1_x')).toEqual({ status: 'done', bucketMonth: '2026-09' });
    expect(statusFromPath('tasks/cancelled/2026-05/20260425_story_pn_x')).toEqual({
      status: 'cancelled',
      bucketMonth: '2026-05',
    });
  });

  it('вложенная подзадача наследует бакет верхнего уровня', () => {
    expect(
      statusFromPath('tasks/done/2026-05/20260506_epic_p0_production-launch/20260506_tech_p0_prod-backup-strategy'),
    ).toEqual({ status: 'done', bucketMonth: '2026-05' });
  });

  it('понимает разделители Windows', () => {
    expect(statusFromPath('tasks\\in-progress\\20260820_bug_p1_x')?.status).toBe('in-progress');
  });

  it('отвергает путь вне tasks/', () => {
    expect(statusFromPath('docs/architecture/DECISIONS.md')).toBeNull();
  });
});

describe('parseTaskFile', () => {
  const header = [
    'Slug: export-csv',
    'Title: Добавить выгрузку в CSV',
    'Type: story',
    'Priority: p1',
    'Status: backlog',
    'Parent: tasks/backlog/epics/20260916_epic_p1_reports/',
    'Created: 2026-09-16',
    'Related:',
    '  - tasks/RULES.md',
    '  - docs/raw/research/tracker-2026-09/04-sync-patterns.md',
    '',
    '---',
    '',
    '## Мотивация (WHY)',
    '',
    'Текст.',
    '',
  ];

  it('разбирает plain-шапку и отделяет тело', () => {
    const { header: h, body } = parseTaskFile(header.join('\n'));
    expect(h.slug).toBe('export-csv');
    expect(h.title).toBe('Добавить выгрузку в CSV');
    expect(h.status).toBe('backlog');
    expect(h.related).toEqual(['tasks/RULES.md', 'docs/raw/research/tracker-2026-09/04-sync-patterns.md']);
    expect(body.startsWith('## Мотивация (WHY)')).toBe(true);
    expect(body).not.toContain('Slug:');
  });

  it('переживает CRLF — файлы репозитория именно такие', () => {
    const { header: h, body } = parseTaskFile(header.join('\r\n'));
    expect(h.slug).toBe('export-csv');
    expect(body.startsWith('## Мотивация (WHY)')).toBe(true);
  });

  it('трактует «Parent: —» как отсутствие родителя', () => {
    const { header: h } = parseTaskFile(['Slug: x', 'Parent: —', '', '---', '', 'тело'].join('\n'));
    expect(h.parent).toBeNull();
  });

  it('не принимает за метаданные строку с двоеточием из тела', () => {
    const { body } = parseTaskFile(['Slug: x', '', '---', '', 'Важно: это тело, а не шапка'].join('\n'));
    expect(body).toBe('Важно: это тело, а не шапка');
  });
});

describe('parentExternalIdFromHeader', () => {
  it('берёт имя папки, а не путь: пути в шапках протухают', () => {
    expect(parentExternalIdFromHeader('tasks/backlog/epics/20260916_epic_p1_reports/', REPO)).toBe(
      'acme-app:20260916_reports',
    );
    expect(parentExternalIdFromHeader('tasks/done/2026-04/20260916_epic_p1_reports', REPO)).toBe(
      'acme-app:20260916_reports',
    );
  });

  it('пустое и мусорное значение — без родителя', () => {
    expect(parentExternalIdFromHeader(null, REPO)).toBeNull();
    expect(parentExternalIdFromHeader('какой-то текст', REPO)).toBeNull();
  });
});

describe('selectScope', () => {
  const epic = task({
    externalId: 'repo:20260916_reports',
    meta: { date: '20260916', type: 'epic', priority: 'p1', slug: 'reports' },
  });
  const story = task({ externalId: 'repo:20260916_export-csv', parentExternalId: 'repo:20260916_reports' });
  const grandchild = task({ externalId: 'repo:20260916_sub', parentExternalId: 'repo:20260916_export-csv' });
  const stranger = task({ externalId: 'repo:20260101_other' });
  const doneOld = task({ externalId: 'repo:20260401_old', status: 'done', bucketMonth: '2026-04' });
  const doneNew = task({ externalId: 'repo:20260901_new', status: 'done', bucketMonth: '2026-09' });
  const all = [epic, story, grandchild, stranger, doneOld, doneNew];

  it('pilot тянет эпик и всё его дерево', () => {
    const picked = selectScope(all, { scope: 'pilot', epics: ['reports'] }).map((t) => t.externalId);
    expect(picked.sort()).toEqual(['repo:20260916_export-csv', 'repo:20260916_reports', 'repo:20260916_sub']);
  });

  it('only сильнее scope', () => {
    expect(selectScope(all, { scope: 'all', only: ['repo:20260401_old'] }).map((t) => t.externalId)).toEqual([
      'repo:20260401_old',
    ]);
  });

  it('active не тянет done и cancelled', () => {
    const picked = selectScope(all, { scope: 'active' }).map((t) => t.externalId);
    expect(picked).not.toContain('repo:20260401_old');
    expect(picked).toContain('repo:20260101_other');
  });

  it('active+done режет архив по границе месяца', () => {
    const picked = selectScope(all, { scope: 'active+done', doneSince: '2026-07' }).map((t) => t.externalId);
    expect(picked).toContain('repo:20260901_new');
    expect(picked).not.toContain('repo:20260401_old');
  });
});

describe('normalizeRemoteUrl', () => {
  it('приводит ssh и https к одной базе', () => {
    expect(normalizeRemoteUrl('https://github.com/acme-org/acme-app.git')).toBe(
      'https://github.com/acme-org/acme-app',
    );
    expect(normalizeRemoteUrl('git@github.com:acme-org/acme-app.git')).toBe(
      'https://github.com/acme-org/acme-app',
    );
    expect(normalizeRemoteUrl('  https://github.com/acme-org/acme-app\n')).toBe(
      'https://github.com/acme-org/acme-app',
    );
  });

  it('выкидывает токен из URL, если он туда попал', () => {
    expect(normalizeRemoteUrl('https://user:ghp_secret@github.com/acme-org/repo.git')).toBe(
      'https://github.com/acme-org/repo',
    );
  });

  it('на непонятном значении возвращает null, а не выдумывает владельца', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('/var/repos/local.git')).toBeNull();
  });
});

describe('rewriteRelativeLinks', () => {
  const opts = {
    taskDir: 'tasks/backlog/stories/20260916_story_p1_x',
    repoUrl: 'https://github.com/acme/repo',
    branch: 'main',
  };

  it('переписывает относительные ссылки от папки задачи', () => {
    expect(rewriteRelativeLinks('см. [правила](../../../RULES.md)', opts)).toBe(
      'см. [правила](https://github.com/acme/repo/blob/main/tasks/RULES.md)',
    );
  });

  it('сохраняет якорь', () => {
    expect(rewriteRelativeLinks('[ADR](../../../../docs/architecture/DECISIONS.md#adr-015)', opts)).toContain(
      '/docs/architecture/DECISIONS.md#adr-015',
    );
  });

  it('не трогает внешние ссылки и якоря', () => {
    const src = '[веб](https://kaiten.ru) и [раздел](#контекст) и [почта](mailto:a@b.c)';
    expect(rewriteRelativeLinks(src, opts)).toBe(src);
  });

  it('оставляет как есть ссылку, уходящую выше корня репозитория', () => {
    const src = '[вне](../../../../../../secret.md)';
    expect(rewriteRelativeLinks(src, opts)).toBe(src);
  });
});
