import { describe, it, expect, beforeAll } from 'vitest';
import { asc, desc } from 'drizzle-orm';
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
import { wrapperSigningKeys } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import {
  createWrapperSigningKeyService,
  toKeyObject,
  SIGNER_CACHE_TTL_MS,
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

/** The `wrapper_signing_keys` columns the fake can order by, by identity. */
const ORDERABLE = new Map<unknown, 'createdAt' | 'id'>([
  [wrapperSigningKeys.createdAt, 'createdAt'],
  [wrapperSigningKeys.id, 'id'],
]);

/**
 * Decodes one `asc(col)` / `desc(col)` fragment into (column, direction).
 *
 * Drizzle renders those as an `SQL` object whose `queryChunks` are the column
 * followed by a literal ` asc` / ` desc`. Both halves must be recoverable or
 * this THROWS: silently defaulting to `'asc'` would restore exactly the hole
 * this fake used to have — a sort direction the test cannot see is a sort
 * direction production is free to get wrong.
 */
function orderTerm(arg: unknown): { field: 'createdAt' | 'id'; direction: 'asc' | 'desc' } {
  const chunks = (arg as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) {
    throw new Error('orderBy() argument is not a drizzle SQL fragment');
  }
  let field: 'createdAt' | 'id' | undefined;
  let direction: 'asc' | 'desc' | undefined;
  for (const chunk of chunks) {
    const known = ORDERABLE.get(chunk);
    if (known) {
      field = known;
      continue;
    }
    const value = (chunk as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) continue;
    const text = value.join('').trim().toLowerCase();
    if (text === 'asc' || text === 'desc') direction = text;
  }
  if (!field) throw new Error('orderBy() names a column this fake does not model');
  if (!direction) throw new Error('orderBy() fragment carries no asc/desc direction');
  return { field, direction };
}

function compareField(a: FakeRow, b: FakeRow, field: 'createdAt' | 'id'): number {
  return field === 'id' ? a.id - b.id : a.createdAt.localeCompare(b.createdAt);
}

function makeFakeDb(rows: FakeRow[]) {
  // Minimal Drizzle-shaped builder: .select().from(t).where(eq).orderBy(…).
  // The service orders by created_at then id and takes no limit, because the
  // primary signer is defined as the OLDEST active row rather than whichever
  // one the storage engine happened to hand back first.
  //
  // `orderBy` HONOURS the columns and directions it is handed instead of
  // sorting to taste, so flipping `asc` to `desc` in the service turns these
  // tests red. It also pre-scrambles the rows into the worst possible starting
  // order, so a query that forgot to sort at all cannot pass by accident.
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async (...args: unknown[]) => {
            if (args.length === 0) throw new Error('orderBy() called without a sort term');
            const terms = args.map(orderTerm);
            return rows
              .filter((r) => r.active === 1)
              .slice()
              .sort((a, b) => compareField(b, a, 'createdAt') || b.id - a.id)
              .sort((a, b) => {
                for (const { field, direction } of terms) {
                  const cmp = compareField(a, b, field);
                  if (cmp !== 0) return direction === 'asc' ? cmp : -cmp;
                }
                return 0;
              });
          },
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

  it('the fake db reads the orderBy arguments instead of sorting to taste', async () => {
    // Guards the guard: the test above can only catch a flipped sort direction
    // while the fake still decodes drizzle's `asc()`/`desc()` fragments. If a
    // drizzle upgrade changes their shape, THIS fails loudly rather than the
    // ordering silently becoming untested again.
    const row = (id: number, createdAt: string): FakeRow => ({
      id,
      algo: 'ed25519',
      publicKey: '',
      privateKeyEnc: null,
      active: 1,
      createdAt,
      rotatedAt: null,
    });
    const db = makeFakeDb([
      row(9, '2026-07-01T00:00:00Z'),
      row(3, '2026-05-01T00:00:00Z'),
    ]) as unknown as {
      select: () => {
        from: () => { where: () => { orderBy: (...args: unknown[]) => Promise<FakeRow[]> } };
      };
    };
    const query = db.select().from().where();

    const ascending = await query.orderBy(
      asc(wrapperSigningKeys.createdAt),
      asc(wrapperSigningKeys.id),
    );
    expect(ascending.map((r) => r.id)).toEqual([3, 9]);

    const descending = await query.orderBy(
      desc(wrapperSigningKeys.createdAt),
      desc(wrapperSigningKeys.id),
    );
    expect(descending.map((r) => r.id)).toEqual([9, 3]);

    await expect(query.orderBy()).rejects.toThrow(/without a sort term/);
    await expect(query.orderBy(wrapperSigningKeys.createdAt)).rejects.toThrow(
      /not a drizzle SQL fragment/,
    );
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

  it('re-reads the table after the cache TTL so a rotation converges without a restart', async () => {
    // `rotate-signing-key add` runs in its own process, so the API's cache is
    // the only thing standing between an added key and the configs it signs.
    const keyring = makeKeyring();
    const first = generateKeyPairSync('ed25519');
    const second = generateKeyPairSync('ed25519');
    const asRow = (id: number, createdAt: string, pair: typeof first): FakeRow => ({
      id,
      algo: 'ed25519',
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }) as string,
      privateKeyEnc: encrypt(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string, keyring),
      active: 1,
      createdAt,
      rotatedAt: null,
    });

    const rows = [asRow(3, '2026-05-01T00:00:00Z', first)];
    let clock = 1_000;
    const svc = createWrapperSigningKeyService({
      db: makeFakeDb(rows),
      keyring,
      cacheTtlMs: 30_000,
      now: () => clock,
    });

    expect((await svc.allActive()).map((s) => s.kid)).toEqual(['3']);

    rows.push(asRow(9, '2026-07-01T00:00:00Z', second));
    clock += 29_000;
    expect((await svc.allActive()).map((s) => s.kid)).toEqual(['3']);

    clock += 2_000;
    expect((await svc.allActive()).map((s) => s.kid)).toEqual(['3', '9']);
  });

  it('caps the default cache lifetime so a rotation cannot need a restart', () => {
    expect(SIGNER_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(SIGNER_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
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
