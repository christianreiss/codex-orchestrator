import { describe, it, expect, beforeAll } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import type { Env } from '../../../src/env.js';
import {
  createWrapperSigningKeyService,
  toKeyObject,
} from '../../../src/services/wrapper-signing-key.js';

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function makeKeyring(): Keyring {
  const raw = sodium.randombytes_buf(32);
  const env = {
    ENCRYPTION_KEYS: `main:${b64(raw)}`,
    ENCRYPTION_ACTIVE_KID: 'main',
  } as unknown as Env;
  return Keyring.fromEnv(env);
}

interface FakeRow {
  id: number;
  algo: string;
  publicKey: string;
  privateKeyEnc: string | null;
  active: number;
  createdAt: string;
  rotatedAt: string | null;
}

function makeFakeDb(rows: FakeRow[]) {
  // Minimal Drizzle-shaped builder: .select().from(t).where(eq).orderBy(…).
  // The service orders by created_at then id and takes no limit, because the
  // primary signer is defined as the OLDEST active row rather than whichever
  // one the storage engine happened to hand back first.
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async (..._args: unknown[]) =>
            rows
              .filter((r) => r.active === 1)
              .slice()
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
        }),
      }),
    }),
  } as unknown as import('../../../src/db/client.js').Database;
}

beforeAll(async () => {
  await sodium.ready;
});

describe('wrapper-signing-key', () => {
  it('returns null when no active row exists', async () => {
    const svc = createWrapperSigningKeyService({ db: makeFakeDb([]), keyring: makeKeyring() });
    expect(await svc.active()).toBeNull();
    expect(await svc.available()).toBe(false);
  });

  it('loads a PEM key from an sbox-encrypted column and signs payloads', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const keyring = makeKeyring();
    const enc = encrypt(pem, keyring);
    const db = makeFakeDb([
      {
        id: 17,
        algo: 'ed25519',
        publicKey: pubPem,
        privateKeyEnc: enc,
        active: 1,
        createdAt: '2026-05-15T00:00:00Z',
        rotatedAt: null,
      },
    ]);

    const svc = createWrapperSigningKeyService({ db, keyring });
    const signer = await svc.active();
    expect(signer).not.toBeNull();
    expect(signer!.kid).toBe('17');

    const sig = signer!.sign('hello-config');
    const verifyKey = createPublicKey(pubPem);
    const ok = cryptoVerify(null, Buffer.from('hello-config', 'utf8'), verifyKey, sig);
    expect(ok).toBe(true);
  });

  it('loads a raw 32-byte seed (base64) and produces a valid signature', async () => {
    // Pre-generate a seed and a known keypair
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
    expect(jwk.d).toBeTruthy();
    const seedBuf = Buffer.from(jwk.d!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const seedB64 = seedBuf.toString('base64');
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const keyring = makeKeyring();
    const enc = encrypt(seedB64, keyring);

    const db = makeFakeDb([
      {
        id: 42,
        algo: 'ed25519',
        publicKey: pubPem,
        privateKeyEnc: enc,
        active: 1,
        createdAt: '2026-05-16T00:00:00Z',
        rotatedAt: null,
      },
    ]);
    const svc = createWrapperSigningKeyService({ db, keyring });
    const signer = await svc.active();
    expect(signer).not.toBeNull();
    const sig = signer!.sign('payload');
    const ok = cryptoVerify(null, Buffer.from('payload', 'utf8'), createPublicKey(pubPem), sig);
    expect(ok).toBe(true);
  });

  it('toKeyObject rejects garbage', () => {
    expect(toKeyObject('not a key')).toBeNull();
    expect(toKeyObject('-----BEGIN PRIVATE KEY-----\nNOT_BASE64\n-----END PRIVATE KEY-----')).toBeNull();
  });

  it('toKeyObject accepts PEM PKCS#8', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const obj = toKeyObject(pem);
    expect(obj).not.toBeNull();
    // Round-trip
    const reExported = obj!.export({ format: 'pem', type: 'pkcs8' });
    expect(typeof reExported).toBe('string');
    void createPrivateKey;
  });

  it('accepts plaintext private key (non-envelope) for legacy rows', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const keyring = makeKeyring();
    const db = makeFakeDb([
      {
        id: 5,
        algo: 'ed25519',
        publicKey: pubPem,
        privateKeyEnc: pem,
        active: 1,
        createdAt: '2026-05-16T00:00:00Z',
        rotatedAt: null,
      },
    ]);
    const svc = createWrapperSigningKeyService({ db, keyring });
    expect(await svc.available()).toBe(true);
  });

  it('orders several active keys oldest-first and keeps the oldest primary', async () => {
    const keyring = makeKeyring();
    const older = generateKeyPairSync('ed25519');
    const newer = generateKeyPairSync('ed25519');
    // Row order is deliberately newest-first: the storage engine returns rows
    // in whatever order it likes, so the service has to sort them itself.
    const db = makeFakeDb([
      {
        id: 9,
        algo: 'ed25519',
        publicKey: newer.publicKey.export({ format: 'pem', type: 'spki' }) as string,
        privateKeyEnc: encrypt(newer.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyring),
        active: 1,
        createdAt: '2026-07-01T00:00:00Z',
        rotatedAt: null,
      },
      {
        id: 3,
        algo: 'ed25519',
        publicKey: older.publicKey.export({ format: 'pem', type: 'spki' }) as string,
        privateKeyEnc: encrypt(older.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyring),
        active: 1,
        createdAt: '2026-05-01T00:00:00Z',
        rotatedAt: null,
      },
    ]);

    const svc = createWrapperSigningKeyService({ db, keyring });
    const all = await svc.allActive();
    expect(all.map((signer) => signer.kid)).toEqual(['3', '9']);
    expect((await svc.active())?.kid).toBe('3');
    expect(await svc.available()).toBe(true);

    for (const [signer, pair] of [
      [all[0]!, older],
      [all[1]!, newer],
    ] as const) {
      const sig = signer.sign('rotation-payload');
      expect(cryptoVerify(null, Buffer.from('rotation-payload', 'utf8'), pair.publicKey, sig)).toBe(true);
    }
  });

  it('fingerprints the raw 32-byte public key with sha256', async () => {
    const keyring = makeKeyring();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
    const raw = Buffer.from(jwk.x!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(raw).toHaveLength(32);

    const db = makeFakeDb([
      {
        id: 11,
        algo: 'ed25519',
        publicKey: publicKey.export({ format: 'pem', type: 'spki' }) as string,
        privateKeyEnc: encrypt(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyring),
        active: 1,
        createdAt: '2026-05-16T00:00:00Z',
        rotatedAt: null,
      },
    ]);
    const signer = await createWrapperSigningKeyService({ db, keyring }).active();
    expect(signer?.publicKey).toBe(raw.toString('base64'));
    expect(signer?.fingerprint).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(signer?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips an unreadable extra key but refuses to promote past an unreadable primary', async () => {
    const keyring = makeKeyring();
    const good = generateKeyPairSync('ed25519');
    const goodRow = {
      id: 3,
      algo: 'ed25519',
      publicKey: good.publicKey.export({ format: 'pem', type: 'spki' }) as string,
      privateKeyEnc: encrypt(good.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyring),
      active: 1,
      createdAt: '2026-05-01T00:00:00Z',
      rotatedAt: null,
    };
    const brokenRow = { ...goodRow, id: 9, privateKeyEnc: 'not-a-key', createdAt: '2026-07-01T00:00:00Z' };

    const withBrokenExtra = createWrapperSigningKeyService({
      db: makeFakeDb([goodRow, brokenRow]),
      keyring,
    });
    expect((await withBrokenExtra.allActive()).map((s) => s.kid)).toEqual(['3']);

    // Reversed ages: the broken row is now the primary. Promoting the readable
    // key would sign configs the fleet's embedded public key cannot verify, so
    // the signer reports itself unavailable instead.
    const withBrokenPrimary = createWrapperSigningKeyService({
      db: makeFakeDb([
        { ...brokenRow, createdAt: '2026-04-01T00:00:00Z' },
        goodRow,
      ]),
      keyring,
    });
    expect(await withBrokenPrimary.allActive()).toEqual([]);
    expect(await withBrokenPrimary.active()).toBeNull();
    expect(await withBrokenPrimary.available()).toBe(false);
  });

  it('invalidate() clears the cache so subsequent active() reloads', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const pubPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const keyring = makeKeyring();
    const enc = encrypt(pem, keyring);
    const db = makeFakeDb([
      {
        id: 1,
        algo: 'ed25519',
        publicKey: pubPem,
        privateKeyEnc: enc,
        active: 1,
        createdAt: '2026-05-16T00:00:00Z',
        rotatedAt: null,
      },
    ]);
    const svc = createWrapperSigningKeyService({ db, keyring });
    const first = await svc.active();
    svc.invalidate();
    const second = await svc.active();
    expect(first?.kid).toBe(second?.kid);
  });
});
