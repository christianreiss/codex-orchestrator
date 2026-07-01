import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
import type { Env } from '../env.js';
import { KEY_BYTES, SecretBoxError } from './secret-box.js';

await sodium.ready;

export interface KeyEntry {
  kid: string;
  key: Uint8Array;
}

/**
 * In-memory holder for libsodium encryption keys.
 *
 * Reads ENCRYPTION_ACTIVE_KEY / AUTH_ENCRYPTION_KEY (single 32-byte base64),
 * plus the optional rotation form ENCRYPTION_KEYS / AUTH_ENCRYPTION_KEYS
 * which is `kid:b64,kid2:b64,…`. When the rotation list is given, the active
 * kid is named by ENCRYPTION_ACTIVE_KID / AUTH_ENCRYPTION_ACTIVE_KID; the
 * single-key path uses the kid 'legacy' to stay byte-compatible with envelopes
 * the PHP code wrote before rotation was introduced.
 */
export class Keyring {
  private constructor(
    private readonly entries: Map<string, KeyEntry>,
    private readonly activeKid: string,
  ) {}

  static fromEnv(env: Env): Keyring {
    const list = env.ENCRYPTION_KEYS ?? env.AUTH_ENCRYPTION_KEYS;
    const single = env.ENCRYPTION_ACTIVE_KEY ?? env.AUTH_ENCRYPTION_KEY;
    const activeKidEnv = env.ENCRYPTION_ACTIVE_KID ?? env.AUTH_ENCRYPTION_ACTIVE_KID;

    const entries = new Map<string, KeyEntry>();

    if (list && list.trim()) {
      for (const pair of list.split(',')) {
        const t = pair.trim();
        if (!t) continue;
        const colon = t.indexOf(':');
        if (colon === -1) throw new SecretBoxError('bad_key', `Bad key entry (missing kid): ${t}`);
        const kid = t.slice(0, colon).trim();
        const b64 = t.slice(colon + 1).trim();
        if (!kid || !b64) throw new SecretBoxError('bad_key', `Bad key entry: ${t}`);
        const key = decodeKey(b64, kid);
        entries.set(kid, { kid, key });
      }
    }

    let activeKid = activeKidEnv ?? '';

    if (single && single.trim()) {
      const kid = activeKid || (entries.size === 0 ? 'legacy' : 'active');
      const key = decodeKey(single.trim(), kid);
      entries.set(kid, { kid, key });
      if (!activeKid) activeKid = kid;
    }

    if (entries.size === 0) {
      throw new SecretBoxError('no_active_key', 'No encryption keys configured');
    }
    if (activeKidEnv && !entries.has(activeKidEnv)) {
      throw new SecretBoxError(
        'no_active_key',
        `Active key kid '${activeKidEnv}' not found among configured keys`,
      );
    }
    if (!activeKid || !entries.has(activeKid)) {
      // Fall back to first inserted
      activeKid = entries.keys().next().value!;
    }
    return new Keyring(entries, activeKid);
  }

  active(): KeyEntry {
    return this.entries.get(this.activeKid)!;
  }

  keyFor(kid: string): KeyEntry | undefined {
    return this.entries.get(kid);
  }

  all(): KeyEntry[] {
    return Array.from(this.entries.values());
  }
}

function decodeKey(b64: string, kid: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
  } catch {
    try {
      raw = sodium.from_base64(b64, sodium.base64_variants.URLSAFE_NO_PADDING);
    } catch {
      throw new SecretBoxError('bad_key', `Key '${kid}' is not valid base64`);
    }
  }
  if (raw.length !== KEY_BYTES) {
    throw new SecretBoxError(
      'bad_key',
      `Key '${kid}' has ${raw.length} bytes, expected ${KEY_BYTES}`,
    );
  }
  return raw;
}
