import * as argon2 from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { check as phpassCheck } from './phpass.js';

/**
 * Verifies a password against the three legacy hash formats and rehashes to
 * argon2id on successful verification of an older format.
 *
 * - `$argon2id$…` → @node-rs/argon2 verify
 * - `$2y$…` / `$2a$…` / `$2b$…` → bcryptjs compare, then rehash
 * - `$P$…` / `$H$…` → inline phpass check, then rehash
 *
 * NOTE: bcryptjs accepts $2y/$2a/$2b prefixes interchangeably.
 */

export interface VerifyResult {
  ok: boolean;
  /** When set, caller should overwrite the stored hash with this new argon2id hash. */
  rehash?: string;
}

const ARGON2_OPTS: argon2.Options = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
  algorithm: argon2.Algorithm.Argon2id,
};

export async function hash(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verify(stored: string, candidate: string): Promise<VerifyResult> {
  if (!stored || !candidate) return { ok: false };

  if (stored.startsWith('$argon2')) {
    try {
      const ok = await argon2.verify(stored, candidate);
      return { ok };
    } catch {
      return { ok: false };
    }
  }

  if (stored.startsWith('$2y$') || stored.startsWith('$2a$') || stored.startsWith('$2b$')) {
    const normalised = stored.startsWith('$2y$') ? '$2a$' + stored.slice(4) : stored;
    let ok: boolean;
    try {
      ok = await bcrypt.compare(candidate, normalised);
    } catch {
      return { ok: false };
    }
    if (!ok) return { ok: false };
    return { ok: true, rehash: await hash(candidate) };
  }

  if (stored.startsWith('$P$') || stored.startsWith('$H$')) {
    let ok = false;
    try {
      ok = phpassCheck(candidate, stored);
    } catch {
      return { ok: false };
    }
    if (!ok) return { ok: false };
    return { ok: true, rehash: await hash(candidate) };
  }

  return { ok: false };
}
