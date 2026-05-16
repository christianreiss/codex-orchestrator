import { randomBytes } from 'node:crypto';
import { sha256 } from '../security/hash.js';

export function generateApiKey(prefix = 'sk-codex-'): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(32).toString('hex');
  const key = `${prefix}${raw}`;
  return { key, hash: sha256(key), prefix };
}

export function hashApiKey(key: string): string {
  return sha256(key);
}

const BEARER_RE = /^bearer\s+(.+)$/i;
export function parseBearer(headerValue: string | string[] | undefined): string | null {
  if (!headerValue) return null;
  const v = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!v) return null;
  const m = BEARER_RE.exec(v);
  return m && m[1] ? m[1].trim() : v.trim();
}

export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'];
  const bearer = parseBearer(auth);
  if (bearer) return bearer;
  const xk = headers['x-api-key'];
  if (typeof xk === 'string' && xk.trim()) return xk.trim();
  if (Array.isArray(xk) && xk[0]) return xk[0].trim();
  return null;
}
