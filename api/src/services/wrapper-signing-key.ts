import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as cryptoSign,
} from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { wrapperSigningKeys } from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, isEnvelope } from '../security/secret-box.js';
import { ownerRuntimeFor, type OwnerRuntime } from '../control-plane/state/runtime.js';

// KeyObjects remain outside public metadata and are scoped to this owner epoch.
const ownedSigners = new WeakMap<OwnerRuntime, { view: object; loading: Promise<WrapperSigner[]> }>();

/**
 * Loads the active Ed25519 wrapper-signing keys from `wrapper_signing_keys`.
 *
 * The `private_key_enc` column holds an `sbox:v1:…` envelope around either a
 * PEM-encoded PKCS#8 private key or the raw 32-byte seed (legacy operator
 * tooling sometimes wrote the bare seed). Both are accepted.
 *
 * Several keys may be active during a staged fleet binary rebuild.
 * Every active key signs the baked config, and the
 * PRIMARY key — the oldest active row — is the one whose signature keeps the
 * `signature` field and the `.sig` file. Ordering is explicit (`created_at`,
 * then `id`) because promoting a newer key would hand hosts a signature the
 * public key embedded in their binary rejects.
 *
 * Returns `null`/`[]` when no active key loads — the routes turn that into a
 * 503 response so operators can see the kill switch from the outside.
 *
 * Each process caches active signers for a bounded time. Add and retire acquire
 * the exclusive database owner lock while the API is stopped. Check the served
 * signatures after the API regains readiness.
 */

/** Maximum age of a cached signer set on the config request path. */
export const SIGNER_CACHE_TTL_MS = 30_000;

export interface WrapperSigner {
  /** Stable identifier embedded in signatures (the DB row id). */
  kid: string;
  /** sha256 of the raw 32-byte Ed25519 public key, lowercase hex. */
  fingerprint: string;
  /** Base64-encoded raw Ed25519 public key (32 bytes). */
  publicKey: string;
  /** Sign `payload` (UTF-8) with Ed25519. Returns the raw 64-byte signature. */
  sign(payload: string | Uint8Array): Buffer;
}

export interface WrapperSigningKeyService {
  /** Returns a signer for the primary (oldest) active row or null if none. */
  active(): Promise<WrapperSigner | null>;
  /** Returns every loadable active signer, oldest first. Primary is `[0]`. */
  allActive(): Promise<WrapperSigner[]>;
  /** Returns true when the service can sign right now. */
  available(): Promise<boolean>;
  /** Invalidate any cached signer (used on rotation). */
  invalidate(): void;
}

export interface WrapperSigningKeyDeps {
  db: Database;
  keyring: Keyring;
  /** Cache lifetime override in ms (tests). Defaults to `SIGNER_CACHE_TTL_MS`. */
  cacheTtlMs?: number;
  /** Monotonic-enough clock, injectable so the TTL is testable without timers. */
  now?: () => number;
}

export function createWrapperSigningKeyService(
  deps: WrapperSigningKeyDeps,
): WrapperSigningKeyService {
  const ttlMs = deps.cacheTtlMs ?? SIGNER_CACHE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  let cached: WrapperSigner[] | undefined;
  let cachedAt = 0;

  function toSigner(row: { id: number; privateKeyEnc: string | null }): WrapperSigner | null {
    if (!row.privateKeyEnc) return null;
    let pkBytes: string;
    try {
      pkBytes = isEnvelope(row.privateKeyEnc)
        ? decrypt(row.privateKeyEnc, deps.keyring)
        : row.privateKeyEnc;
    } catch {
      return null;
    }

    const keyObj = toKeyObject(pkBytes);
    if (!keyObj) return null;

    const raw = rawPublicKey(keyObj);
    if (!raw) return null;

    return {
      kid: String(row.id),
      fingerprint: createHash('sha256').update(raw).digest('hex'),
      publicKey: raw.toString('base64'),
      sign(payload: string | Uint8Array): Buffer {
        const buf =
          typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
        // Ed25519 in node:crypto: pass `null` as algorithm (the key carries it).
        return cryptoSign(null, buf, keyObj);
      },
    };
  }

  async function load(): Promise<WrapperSigner[]> {
    const owner = ownerRuntimeFor(deps.db);
    if (owner) {
      owner.assertOwner();
      const view = owner.state.snapshot().table('wrapperSigningKeys');
      const existing = ownedSigners.get(owner);
      if (existing?.view === view) return existing.loading;
      const active = view.all().filter(row => row.active === 1).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id-b.id);
      const loading = (async () => {
        const keys: Array<WrapperSigner | null> = [];
        for (const metadata of active) {
          const [row] = await deps.db.select().from(wrapperSigningKeys).where(eq(wrapperSigningKeys.id,metadata.id));
          keys.push(row && isEnvelope(row.privateKeyEnc) ? toSigner(row) : null);
        }
        owner.assertOwner();
        if (owner.state.snapshot().table('wrapperSigningKeys') !== view) return load();
        return keys[0] ? keys.filter((key): key is WrapperSigner => key !== null) : [];
      })();
      ownedSigners.set(owner,{view,loading});
      try { return await loading; } catch (error) { if (ownedSigners.get(owner)?.loading === loading) ownedSigners.delete(owner); throw error; }
    }
    if (cached !== undefined && now() - cachedAt < ttlMs) return cached;
    const rows = await deps.db
      .select()
      .from(wrapperSigningKeys)
      .where(eq(wrapperSigningKeys.active, 1))
      .orderBy(asc(wrapperSigningKeys.createdAt), asc(wrapperSigningKeys.id));
    const signers = rows.map((row) => toSigner(row));
    // An unreadable PRIMARY row is the whole signer being down, exactly as it
    // was when only one row could ever be active: silently promoting the next
    // key would sign configs the fleet's embedded public key cannot verify.
    // A later key that fails to load is simply not offered as an extra
    // signature.
    cached = signers[0] ? signers.filter((signer): signer is WrapperSigner => signer !== null) : [];
    cachedAt = now();
    return cached;
  }

  return {
    async active() {
      return (await load())[0] ?? null;
    },
    async allActive() {
      return [...(await load())];
    },
    async available() {
      return (await load()).length > 0;
    },
    invalidate() {
      cached = undefined;
      const owner = ownerRuntimeFor(deps.db);
      if (owner) ownedSigners.delete(owner);
    },
  };
}

/**
 * Normalizes any accepted Ed25519 public-key material — base64 raw, a public
 * SPKI PEM, or a private PEM — to the base64 raw 32-byte public key. Throws
 * when the material is not an Ed25519 key.
 */
export function publicKeyB64(material: string): string {
  const trimmed = material.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed) && Buffer.from(trimmed, 'base64').length === 32) {
    return trimmed;
  }
  const key = trimmed.includes('PRIVATE KEY') ? toKeyObject(trimmed) : null;
  const publicKey = key ? createPublicKey(key) : createPublicKey(trimmed);
  const raw = rawPublicKey(publicKey);
  if (!raw) throw new Error('signing material is not an Ed25519 key');
  return raw.toString('base64');
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

/**
 * The raw 32-byte Ed25519 public key behind `keyObj` (public or private), or
 * null when it is not an Ed25519 key. Both `WrapperSigner.publicKey` and its
 * fingerprint are derived from these bytes so the two can never disagree.
 */
function rawPublicKey(keyObj: KeyObject): Buffer | null {
  try {
    const pub = keyObj.type === 'public' ? keyObj : createPublicKey(keyObj);
    // raw 32-byte ed25519 public key from the JWK base64url `x` coordinate
    const jwk = pub.export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) return null;
    const raw = Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}
