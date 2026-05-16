import { createPrivateKey, createPublicKey, type KeyObject, sign as cryptoSign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { wrapperSigningKeys } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, isEnvelope } from '../security/secret-box.js';

/**
 * Loads the active Ed25519 wrapper-signing key from `wrapper_signing_keys`.
 *
 * The `private_key_enc` column holds an `sbox:v1:…` envelope around either a
 * PEM-encoded PKCS#8 private key or the raw 32-byte seed (legacy operator
 * tooling sometimes wrote the bare seed). Both are accepted.
 *
 * Returns `null` when no active key exists — the routes turn that into a 503
 * response so operators can see the kill switch from the outside.
 */

export interface WrapperSigner {
  /** Stable identifier embedded in signatures (the DB row id). */
  kid: string;
  /** Base64-encoded raw Ed25519 public key (32 bytes), if the column held PEM. */
  publicKey: string;
  /** Sign `payload` (UTF-8) with Ed25519. Returns the raw 64-byte signature. */
  sign(payload: string | Uint8Array): Buffer;
}

export interface WrapperSigningKeyService {
  /** Returns a signer for the currently-active row or null if none. */
  active(): Promise<WrapperSigner | null>;
  /** Returns true when the service can sign right now. */
  available(): Promise<boolean>;
  /** Invalidate any cached signer (used on rotation). */
  invalidate(): void;
}

export interface WrapperSigningKeyDeps {
  db: Database;
  keyring: Keyring;
}

export function createWrapperSigningKeyService(
  deps: WrapperSigningKeyDeps,
): WrapperSigningKeyService {
  let cached: WrapperSigner | null | undefined;

  async function load(): Promise<WrapperSigner | null> {
    if (cached !== undefined) return cached;
    const rows = await deps.db
      .select()
      .from(wrapperSigningKeys)
      .where(eq(wrapperSigningKeys.active, 1))
      .limit(1);
    const row = rows[0];
    if (!row || !row.privateKeyEnc) {
      cached = null;
      return cached;
    }
    let pkBytes: string;
    try {
      pkBytes = isEnvelope(row.privateKeyEnc)
        ? decrypt(row.privateKeyEnc, deps.keyring)
        : row.privateKeyEnc;
    } catch {
      cached = null;
      return cached;
    }

    const keyObj = toKeyObject(pkBytes);
    if (!keyObj) {
      cached = null;
      return cached;
    }

    const publicKey = derivePublicKeyB64(keyObj, row.publicKey);
    cached = {
      kid: String(row.id),
      publicKey,
      sign(payload: string | Uint8Array): Buffer {
        const buf =
          typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
        // Ed25519 in node:crypto: pass `null` as algorithm (the key carries it).
        return cryptoSign(null, buf, keyObj);
      },
    };
    return cached;
  }

  return {
    active() {
      return load();
    },
    async available() {
      const s = await load();
      return s !== null;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * Accepts either a PEM-encoded PKCS#8 Ed25519 private key or a raw 32-byte
 * seed (binary, base64, or hex) and returns a `KeyObject` ready for `crypto.sign`.
 */
export function toKeyObject(material: string): KeyObject | null {
  const trimmed = material.trim();
  if (trimmed.includes('-----BEGIN')) {
    try {
      return createPrivateKey({ key: trimmed, format: 'pem' });
    } catch {
      return null;
    }
  }
  // Raw 32-byte seed, base64 or hex or binary
  const seed = decodeSeed(trimmed);
  if (!seed) return null;
  // Wrap a 32-byte seed in PKCS#8 to feed into node:crypto.
  const pkcs8 = wrapSeedInPkcs8(seed);
  try {
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

function decodeSeed(material: string): Buffer | null {
  if (material.length === 32) {
    return Buffer.from(material, 'binary');
  }
  // hex
  if (/^[0-9a-fA-F]{64}$/.test(material)) {
    return Buffer.from(material, 'hex');
  }
  // base64
  try {
    const b = Buffer.from(material, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Pre-built ASN.1 wrapper for a PKCS#8-encoded Ed25519 private key. The 32-byte
 * seed sits at offset 16 of this 48-byte structure:
 *
 *   SEQUENCE (16 bytes header)
 *     INTEGER 0
 *     AlgorithmIdentifier(ed25519 = 1.3.101.112)
 *     OCTET STRING {
 *       OCTET STRING <seed>
 *     }
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function wrapSeedInPkcs8(seed: Buffer): Buffer {
  return Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
}

function derivePublicKeyB64(keyObj: KeyObject, fallback: string): string {
  try {
    const pub = createPublicKey(keyObj);
    // raw 32-byte ed25519 public key for JWK base64url -> base64 transform
    const jwk = pub.export({ format: 'jwk' }) as { x?: string };
    if (jwk.x) {
      return Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
    }
  } catch {
    /* fall through */
  }
  return fallback;
}
