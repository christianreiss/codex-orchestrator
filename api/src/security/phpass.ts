import { createHash } from 'node:crypto';

/**
 * Inline port of the verify path from Openwall's PortableHash (phpass).
 * Encoded format: `$P$` or `$H$` + 1-char iteration count + 8-char salt +
 * 22-char itoa64-encoded MD5 hash. Iteration count is itoa64[char]; the
 * digest is MD5^(2^count) over (salt || password).
 *
 * Only the verify path is implemented; new hashes use argon2id.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function check(password: string, stored: string): boolean {
  if (!stored || stored.length < 12) return false;
  if (stored[0] !== '$' || (stored[1] !== 'P' && stored[1] !== 'H') || stored[2] !== '$') return false;

  const countLog2 = ITOA64.indexOf(stored[3]!);
  if (countLog2 < 7 || countLog2 > 30) return false;
  const count = 1 << countLog2;

  const salt = stored.slice(4, 12);
  if (salt.length !== 8) return false;

  const expected = stored.slice(12);
  if (expected.length !== 22) return false;

  let hash = md5(Buffer.concat([Buffer.from(salt, 'binary'), Buffer.from(password, 'utf8')]));
  for (let i = 0; i < count; i++) {
    hash = md5(Buffer.concat([hash, Buffer.from(password, 'utf8')]));
  }

  const encoded = encode64(hash, 16);
  if (encoded.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < encoded.length; i++) {
    diff |= encoded.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function md5(buf: Buffer): Buffer {
  return createHash('md5').update(buf).digest();
}

function encode64(input: Buffer, count: number): string {
  let out = '';
  let i = 0;
  while (i < count) {
    let value = input[i++]!;
    out += ITOA64[value & 0x3f];
    if (i < count) value |= input[i]! << 8;
    out += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= count) break;
    if (i < count) value |= input[i]! << 16;
    out += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= count) break;
    out += ITOA64[(value >> 18) & 0x3f];
  }
  return out;
}
