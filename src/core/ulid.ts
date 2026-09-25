/**
 * ULID для поля `id`: генерируется один раз при создании задачи и больше
 * никогда не перезаписывается. Не ключ трекера сознательно — агент заводит
 * задачу локально, не спрашивая Kaiten (story `export-csv`).
 *
 * 48 бит времени в мс + 80 бит случайности, Crockford base32. Монотонность
 * внутри одной миллисекунды не нужна: id сравнивают на равенство, не сортируют.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  if (!Number.isInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new Error(`ulid: время вне диапазона: ${now}`);
  if (random.length !== 10) throw new Error('ulid: нужно ровно 10 случайных байт');

  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }

  // 80 бит → 16 символов по 5 бит.
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let rand = '';
  for (let i = 0; i < 16; i += 1) {
    rand = ALPHABET[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}
