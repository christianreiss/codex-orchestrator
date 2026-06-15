import { createHash, randomBytes } from 'node:crypto';

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

