import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function constantTimeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}
