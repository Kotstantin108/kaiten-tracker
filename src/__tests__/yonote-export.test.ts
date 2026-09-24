/**
 * Чистая часть выгрузки yonote. Главное, что здесь может сломаться молча, —
 * переписывание ссылок: пропущенное вложение станет битой картинкой ровно в
 * тот момент, когда yonote выключат и перепроверить будет нечем.
 */
import { describe, expect, it } from 'vitest';

import {
  cellLabel,
  countCheckboxes,
  databaseCsv,
  documentPath,
  extensionFor,
  externalHosts,
  findAttachmentRefs,
  rewriteLinks,
} from '../yonote-export.js';

const A = '0a1b2c3d-1111-2222-3333-444455556666';
const B = 'ffffffff-aaaa-bbbb-cccc-dddddddddddd';

describe('findAttachmentRefs', () => {
  it('находит относительные и абсолютные ссылки, не дублирует одинаковые', () => {
    const md = [
      `![](/api/attachments.redirect?id=${A})`,
      `[договор.pdf 120 kB](https://team.yonote.ru/api/attachments.redirect?id=${B})`,
      `и ещё раз ![](/api/attachments.redirect?id=${A})`,
    ].join('\n');
    const refs = findAttachmentRefs(md);
    expect(refs.map((r) => r.id)).toEqual([A, B]);
    expect(refs[1].raw).toBe(`https://team.yonote.ru/api/attachments.redirect?id=${B}`);
  });

  it('нормализует регистр UUID', () => {
    expect(findAttachmentRefs(`/api/attachments.redirect?id=${A.toUpperCase()}`)[0].id).toBe(A);
  });
});

describe('rewriteLinks', () => {
  it('вложения — на ../attachments, документы — на ./<id>.md', () => {
    const md = `![](/api/attachments.redirect?id=${A}) см. [план](/doc/plan-na-kvartal-AbCdEfGhIj) и [тоже](https://team.yonote.ru/doc/XyZ0123456#h)`;
    const result = rewriteLinks(
      md,
      new Map([[A, `${A}.png`]]),
      new Map([
        ['AbCdEfGhIj', 'doc-1'],
        ['XyZ0123456', 'doc-2'],
      ]),
    );
    expect(result.markdown).toBe(`![](../attachments/${A}.png) см. [план](./doc-1.md) и [тоже](./doc-2.md#h)`);
    expect(result.missingAttachments).toEqual([]);
    expect(result.unresolvedDocLinks).toEqual([]);
  });

  it('неизвестное оставляет как было и сообщает об этом', () => {
    const md = `![](/api/attachments.redirect?id=${B}) [x](/doc/chuzhoy-QQQQQQQQQQ)`;
    const result = rewriteLinks(md, new Map(), new Map());
    expect(result.markdown).toBe(md);
    expect(result.missingAttachments).toEqual([B]);
    expect(result.unresolvedDocLinks).toEqual(['QQQQQQQQQQ']);
  });

  it('не трогает похожие, но чужие ссылки', () => {
    const md = '[гугл](https://docs.google.com/document/d/abc) [doc](/docs/intro)';
    expect(rewriteLinks(md, new Map(), new Map()).markdown).toBe(md);
  });
});

describe('countCheckboxes', () => {
  it('считает открытые и закрытые пункты во всех видах списков', () => {
    const md = ['- [ ] один', '- [x] два', '  * [X] вложенный', '1. [ ] нумерованный', 'текст [ ] не пункт', '+ [ ] плюс'].join('\n');
    expect(countCheckboxes(md)).toEqual({ open: 3, done: 2 });
  });
});

describe('documentPath', () => {
  const collections = new Map([['c1', 'Компания']]);

  it('собирает путь от коллекции до документа', () => {
    const byId = new Map([
      ['root', { id: 'root', title: 'Процессы', collectionId: 'c1', parentDocumentId: null }],
      ['kid', { id: 'kid', title: 'Найм', collectionId: 'c1', parentDocumentId: 'root' }],
    ]);
    expect(documentPath(byId.get('kid')!, byId, collections)).toEqual(['Компания', 'Процессы', 'Найм']);
  });

  it('родитель вне выгрузки — пометка, а не обрезанный путь', () => {
    const doc = { id: 'kid', title: 'Найм', collectionId: 'c1', parentDocumentId: 'gone' };
    expect(documentPath(doc, new Map([['kid', doc]]), collections)).toEqual(['Компания', '[родитель gone вне выгрузки]', 'Найм']);
  });

  it('цикл в данных не вешает обход', () => {
    const byId = new Map([
      ['a', { id: 'a', title: 'A', collectionId: 'c1', parentDocumentId: 'b' }],
      ['b', { id: 'b', title: 'B', collectionId: 'c1', parentDocumentId: 'a' }],
    ]);
    expect(documentPath(byId.get('a')!, byId, collections)).toEqual(['Компания', '[цикл в дереве]', 'B', 'A']);
  });
});

describe('мелочи', () => {
  it('расширение по Content-Type', () => {
    expect(extensionFor('image/png')).toBe('.png');
    expect(extensionFor('application/pdf; charset=binary')).toBe('.pdf');
    expect(extensionFor(null)).toBe('.bin');
  });

  it('внешние хосты — без путей', () => {
    expect(externalHosts('[a](https://Example.com/secret/path) ![](http://img.host/x.png) https://example.com')).toEqual([
      'example.com',
      'img.host',
    ]);
  });
});

describe('базы данных yonote', () => {
  const properties = {
    title: { id: 'title', type: 'text', title: 'Название' },
    p1: {
      id: 'p1',
      type: 'status',
      title: 'Статус',
      options: [
        { id: 'o1', label: 'В работе', value: 'in_progress' },
        { id: 'o2', label: 'Готово' },
      ],
    },
    p2: { id: 'p2', type: 'people', title: 'Исполнители', options: [{ id: 'u1', label: 'Аня' }, { id: 'u2', label: 'Боря' }] },
    p3: { id: 'p3', type: 'text', title: 'Комментарий, "важно"' },
  };

  it('подпись варианта по id и по value; несколько людей через запятую; неизвестное — как есть', () => {
    expect(cellLabel(properties.p1, 'o2')).toBe('Готово');
    expect(cellLabel(properties.p1, 'in_progress')).toBe('В работе');
    expect(cellLabel(properties.p2, 'u1,u2')).toBe('Аня, Боря');
    expect(cellLabel(properties.p1, 'o9')).toBe('o9');
    expect(cellLabel(properties.p2, ['u1', 'Вика'])).toBe('Аня, Вика');
    expect(cellLabel(undefined, { a: 1 })).toBe('{"a":1}');
    expect(cellLabel(properties.p3, undefined)).toBe('');
  });

  it('CSV: порядок по numId, экранирование, колонка title не дублируется', () => {
    const csv = databaseCsv(properties, [
      { id: 'r2', title: 'Вторая', numId: 2, values: { p1: 'o1' } },
      { id: 'r1', title: 'Первая, срочно', numId: 1, values: { p1: 'o2', p2: 'u2', p3: 'строка\nдве' } },
    ]);
    expect(csv).toBe(
      [
        'numId,title,documentId,Статус,Исполнители,"Комментарий, ""важно"""',
        '1,"Первая, срочно",r1,Готово,Боря,"строка\nдве"',
        '2,Вторая,r2,В работе,,',
        '',
      ].join('\n'),
    );
  });
});
