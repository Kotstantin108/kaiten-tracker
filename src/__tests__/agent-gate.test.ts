/**
 * Заслонка и ключ агентского сервера.
 *
 * Заслонка — то, на чём держится «агент не удаляет и не раздаёт доступ», даже
 * если инструмент ошибся. Поэтому здесь перечислены именно опасные запросы,
 * найденные живьём: удаление, выдача доступа по почте, документ без родителя,
 * копия документа, удаление карточки через правку.
 */
import { describe, expect, it, vi } from 'vitest';

import { checkKaitenCall, GATE_HEADER, gatedFetch } from '../agent-server/gate.js';
import { openKey, sealToken, sign, verify } from '../agent-server/key.js';
import { KaitenApiError, KaitenClient } from '../kaiten-client.js';

const SECRET = 'x'.repeat(40);
const body = (value: unknown): string => JSON.stringify(value);

describe('checkKaitenCall', () => {
  it.each([
    ['DELETE', '/cards/1'],
    ['DELETE', '/documents/abc'],
    ['DELETE', '/document-groups/abc'],
    ['POST', '/documents/abc/users'],
    ['POST', '/document-groups/abc/users'],
    ['POST', '/spaces/1/users'],
    ['POST', '/spaces'],
    ['POST', '/spaces/1/boards'],
    ['POST', '/boards/1/columns'],
    ['PATCH', '/card-types/1'],
    ['POST', '/spaces/1/restrictions'],
    ['PATCH', '/company/users/1'],
    ['PUT', '/cards/1/files'],
    ['POST', '/document-groups'],
  ])('%s %s — отказ', (method, path) => {
    expect(checkKaitenCall(method, path, body({}))).not.toBeNull();
  });

  it('чтение разрешено, кроме настроек компании', () => {
    expect(checkKaitenCall('GET', '/cards/1')).toBeNull();
    expect(checkKaitenCall('GET', '/tree-entities')).toBeNull();
    expect(checkKaitenCall('GET', '/companies/current')).not.toBeNull();
    expect(checkKaitenCall('GET', '/companies')).not.toBeNull();
  });

  it('карточку нельзя удалить или архивировать правкой', () => {
    expect(checkKaitenCall('PATCH', '/cards/1', body({ condition: 3 }))).toMatch(/condition/);
    expect(checkKaitenCall('PATCH', '/cards/1', body({ archived: true }))).toMatch(/archived/);
    expect(checkKaitenCall('PATCH', '/cards/1', body({ due_date: '2026-01-01' }))).toMatch(/due_date/);
    expect(checkKaitenCall('PATCH', '/cards/1', body({ column_id: 5, properties: {} }))).toBeNull();
  });

  it('документ — только с родителем и без копирования и доступа', () => {
    expect(checkKaitenCall('POST', '/documents', body({ title: 'a', sort_order: 1 }))).toMatch(/родител/);
    expect(checkKaitenCall('POST', '/documents', body({ title: 'a', parent_entity_uid: 'g1', clone_uid: 'd1' }))).toMatch(/clone_uid/);
    expect(checkKaitenCall('POST', '/documents', body({ title: 'a', sort_order: 1, parent_entity_uid: 'g1' }))).toBeNull();
    expect(checkKaitenCall('PATCH', '/documents/d1', body({ access: 'for_everyone' }))).toMatch(/access/);
    expect(checkKaitenCall('PATCH', '/documents/d1', body({ data: { type: 'doc', content: [] } }))).toBeNull();
  });

  it('срок — только при создании; время, владелец и ответственный — никогда', () => {
    expect(checkKaitenCall('POST', '/cards', body({ title: 'a', board_id: 1, due_date: '2026-10-21' }))).toBeNull();
    expect(checkKaitenCall('POST', '/cards', body({ title: 'a', board_id: 1, due_date_time_present: true }))).toMatch(/due_date_time_present/);
    expect(checkKaitenCall('POST', '/cards', body({ title: 'a', board_id: 1, responsible_id: 5 }))).toMatch(/responsible_id/);
  });

  it('файл — только по UUID карточки, одним полем file, без пути в имени и до 10 МБ', () => {
    const uid = '0a1b2c3d-0000-4000-8000-000000000001';
    const form = (name: string, size = 3, field = 'file'): FormData => {
      const f = new FormData();
      f.append(field, new Blob([new Uint8Array(size)]), name);
      return f;
    };
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, form('счёт.pdf'))).toBeNull();
    expect(checkKaitenCall('POST', '/cards/123/files', form('счёт.pdf'))).toMatch(/недоступен/);
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, form('img/a.png'))).toMatch(/имя файла/);
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, form('a\\b.png'))).toMatch(/имя файла/);
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, form('a.pdf', 3, 'other'))).toMatch(/только поле file/);
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, form('big.pdf', 10 * 1024 * 1024 + 1))).toMatch(/10 МБ/);
    expect(checkKaitenCall('POST', `/cards/${uid}/files`, body({ name: 'a' }))).toMatch(/формой/);
    expect(checkKaitenCall('POST', '/cards/1/comments', form('a.pdf'))).toMatch(/форма/);
    expect(checkKaitenCall('PATCH', `/cards/${uid}/files/${uid}`, body({ name: 'x' }))).toMatch(/недоступен/);
  });

  it('тело записи — только JSON-объект', () => {
    expect(checkKaitenCall('POST', '/cards/1/comments', '[1]')).toMatch(/JSON/);
    expect(checkKaitenCall('POST', '/cards/1/comments', 'не json')).toMatch(/JSON/);
  });
});

describe('gatedFetch', () => {
  const base = 'https://acme.example.com/api/latest';

  it('пропускает разрешённое и не пускает в сеть запрещённое', async () => {
    const inner = vi.fn(async () => new Response('{}', { status: 200 }));
    const gated = gatedFetch(inner, base);
    await gated(`${base}/cards/1`, { method: 'GET' });
    const refused = await gated(`${base}/documents/abc`, { method: 'DELETE' });
    expect(refused.status).toBe(403);
    expect(refused.headers.get(GATE_HEADER)).toBe('1');
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('не ходит никуда, кроме Kaiten', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const gated = gatedFetch(inner, base);
    expect((await gated('https://evil.example.org/api/latest/cards', {})).status).toBe(403);
    expect((await gated('https://acme.example.com/other', {})).status).toBe(403);
    expect(inner).not.toHaveBeenCalled();
  });

  it('клиент Kaiten получает отказ сразу, без повторов', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const client = new KaitenClient({ domain: 'acme.example.com', token: 't', fetchImpl: gatedFetch(inner, base), sleep: async () => {} });
    await expect(client.updateCard(1, { condition: 3 } as never)).rejects.toBeInstanceOf(KaitenApiError);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('ключ агента', () => {
  it('шифрует и расшифровывает токен', async () => {
    const key = await sealToken('token-123', SECRET);
    expect(key).toMatch(/^kag1\./);
    expect(key).not.toContain('token-123');
    expect(await openKey(key, SECRET)).toBe('token-123');
  });

  it('чужой секрет, испорченный или чужой ключ — null', async () => {
    const key = await sealToken('token-123', SECRET);
    expect(await openKey(key, 'y'.repeat(40))).toBeNull();
    expect(await openKey(`${key.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(await openKey('token-123', SECRET)).toBeNull();
    expect(await openKey('kag1.!!!', SECRET)).toBeNull();
  });

  it('подпись привязана к назначению и содержимому', async () => {
    const signature = await sign('preview', 'payload', SECRET);
    expect(await verify('preview', 'payload', signature, SECRET)).toBe(true);
    expect(await verify('preview', 'payload2', signature, SECRET)).toBe(false);
    expect(await verify('confirm', 'payload', signature, SECRET)).toBe(false);
  });

  it('короткий секрет не принимается', async () => {
    await expect(sealToken('t', 'short')).rejects.toThrow(/32/);
  });
});
