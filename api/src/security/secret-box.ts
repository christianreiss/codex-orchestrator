// The ESM build of libsodium-wrappers v0.7.x references a peer file by
// relative path that isn't bundled in the wrappers package; loading via CJS
// resolves the dependency through node_modules normally.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
import type { Keyring } from './keyring.js';

/**
 * Drop-in replacement for the PHP App\Security\SecretBox helper. The wire
 * format is preserved exactly so existing rows are decryptable:
 *
 *   modern:  sbox:v1:kid=<url-encoded-kid>:<base64(nonce || ciphertext)>
 *   legacy:  sbox:v1:<base64(nonce || ciphertext)>     (no kid → 'legacy')
 *
 * Underneath: XSalsa20-Poly1305 via crypto_secretbox.
 */

await sodium.ready;

const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES; // 24
export const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES; // 32

export class SecretBoxError extends Error {
  constructor(
    public readonly reason: 'not_an_envelope' | 'decrypt_failed' | 'no_active_key' | 'bad_key',
    message?: string,
  ) {
    super(message ?? reason);
  }
}

const ENVELOPE_RE = /^sbox:v1:(?:kid=([^:]+):)?([A-Za-z0-9+/=]+)$/;

export function isEnvelope(s: string | null | undefined): s is string {
  return typeof s === 'string' && ENVELOPE_RE.test(s);
}

export function encrypt(plaintext: string, keyring: Keyring): string {
  const active = keyring.active();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, active.key);
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce, 0);
  combined.set(ct, nonce.length);
  const b64 = sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
  return `sbox:v1:kid=${encodeURIComponent(active.kid)}:${b64}`;
}

export function decrypt(envelope: string, keyring: Keyring): string {
  const m = ENVELOPE_RE.exec(envelope);
  if (!m) throw new SecretBoxError('not_an_envelope');
  const kid = m[1] !== undefined ? decodeURIComponent(m[1]) : 'legacy';
  let buf: Uint8Array;
  try {
    buf = sodium.from_base64(m[2]!, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new SecretBoxError('decrypt_failed', 'invalid base64 in envelope');
  }
  if (buf.length <= NONCE_BYTES) throw new SecretBoxError('decrypt_failed', 'envelope too short');
  const nonce = buf.slice(0, NONCE_BYTES);
  const ct = buf.slice(NONCE_BYTES);

  const tried = new Set<string>();
  const primary = keyring.keyFor(kid);
  if (primary) {
    tried.add(primary.kid);
    try {
      const pt = sodium.crypto_secretbox_open_easy(ct, nonce, primary.key);
      return sodium.to_string(pt);
    } catch {
      /* fall through */
    }
  }
  // Try every known key; legacy envelopes have no kid and we may have rotated
  for (const k of keyring.all()) {
    if (tried.has(k.kid)) continue;
    try {
      const pt = sodium.crypto_secretbox_open_easy(ct, nonce, k.key);
      return sodium.to_string(pt);
    } catch {
      /* keep trying */
    }
  }
  throw new SecretBoxError('decrypt_failed');
}

export function decryptOrNull(envelope: string | null | undefined, keyring: Keyring): string | null {
  if (!envelope) return null;
  if (!isEnvelope(envelope)) return envelope; // not encrypted; pass through (legacy plaintext rows)
  try {
    return decrypt(envelope, keyring);
  } catch {
    return null;
  }
}
