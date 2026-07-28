import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
import { Keyring } from '../../../src/security/keyring.js';
import { SecretBoxError } from '../../../src/security/secret-box.js';
import type { Env } from '../../../src/env.js';

const KEY_BYTES = 32;

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function makeKeyB64(): string {
  return b64(sodium.randombytes_buf(KEY_BYTES));
}

/** Only the encryption vars matter here; the rest of Env is never read. */
function env(vars: Partial<Env>): Env {
  return vars as unknown as Env;
}

function expectSecretBoxError(fn: () => unknown, reason: SecretBoxError['reason']): void {
  expect(fn).toThrow(SecretBoxError);
  try {
    fn();
    expect.unreachable('expected fn to throw');
  } catch (err) {
    expect((err as SecretBoxError).reason).toBe(reason);
  }
}

beforeAll(async () => {
  await sodium.ready;
});

describe('Keyring.fromEnv', () => {
  it("uses the kid 'legacy' for a single key with no rotation list", () => {
    const key = makeKeyB64();
    const ring = Keyring.fromEnv(env({ ENCRYPTION_ACTIVE_KEY: key }));

    expect(ring.active().kid).toBe('legacy');
    expect(b64(ring.active().key)).toBe(key);
    expect(ring.all().map((e) => e.kid)).toEqual(['legacy']);
  });

  it("uses the kid 'active' for a single key alongside a rotation list", () => {
    const listed = makeKeyB64();
    const single = makeKeyB64();
    const ring = Keyring.fromEnv(
      env({ ENCRYPTION_KEYS: `old:${listed}`, ENCRYPTION_ACTIVE_KEY: single }),
    );

    expect(ring.active().kid).toBe('active');
    expect(b64(ring.active().key)).toBe(single);
    expect(ring.all().map((e) => e.kid)).toEqual(['old', 'active']);
  });

  it('names the active key from ENCRYPTION_ACTIVE_KID', () => {
    const k1 = makeKeyB64();
    const k2 = makeKeyB64();
    const ring = Keyring.fromEnv(
      env({ ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, ENCRYPTION_ACTIVE_KID: 'k2' }),
    );

    expect(ring.active().kid).toBe('k2');
    expect(b64(ring.active().key)).toBe(k2);
  });

  it('adopts the ACTIVE_KID as the kid of a single key', () => {
    const key = makeKeyB64();
    const ring = Keyring.fromEnv(
      env({ ENCRYPTION_ACTIVE_KEY: key, ENCRYPTION_ACTIVE_KID: 'primary' }),
    );

    expect(ring.active().kid).toBe('primary');
    expect(ring.all().map((e) => e.kid)).toEqual(['primary']);
  });

  it('falls back to the first inserted kid when no ACTIVE_KID is given', () => {
    const k1 = makeKeyB64();
    const k2 = makeKeyB64();
    const ring = Keyring.fromEnv(env({ ENCRYPTION_KEYS: `first:${k1},second:${k2}` }));

    expect(ring.active().kid).toBe('first');
    expect(b64(ring.active().key)).toBe(k1);
  });

  it('treats AUTH_ENCRYPTION_KEY like ENCRYPTION_ACTIVE_KEY', () => {
    const key = makeKeyB64();
    const ring = Keyring.fromEnv(env({ AUTH_ENCRYPTION_KEY: key }));

    expect(ring.active().kid).toBe('legacy');
    expect(b64(ring.active().key)).toBe(key);
  });

  it('treats AUTH_ENCRYPTION_KEYS / AUTH_ENCRYPTION_ACTIVE_KID like their ENCRYPTION_* twins', () => {
    const k1 = makeKeyB64();
    const k2 = makeKeyB64();
    const aliased = Keyring.fromEnv(
      env({ AUTH_ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, AUTH_ENCRYPTION_ACTIVE_KID: 'k2' }),
    );
    const canonical = Keyring.fromEnv(
      env({ ENCRYPTION_KEYS: `k1:${k1},k2:${k2}`, ENCRYPTION_ACTIVE_KID: 'k2' }),
    );

    expect(aliased.active().kid).toBe(canonical.active().kid);
    expect(aliased.all().map((e) => e.kid)).toEqual(canonical.all().map((e) => e.kid));
    expect(b64(aliased.active().key)).toBe(k2);
  });

  it('prefers the ENCRYPTION_* vars over the AUTH_ENCRYPTION_* aliases', () => {
    const preferred = makeKeyB64();
    const alias = makeKeyB64();
    const ring = Keyring.fromEnv(
      env({ ENCRYPTION_KEYS: `k:${preferred}`, AUTH_ENCRYPTION_KEYS: `k:${alias}` }),
    );

    expect(b64(ring.keyFor('k')!.key)).toBe(preferred);
  });

  it('exposes every parsed entry via all() and keyFor()', () => {
    const k1 = makeKeyB64();
    const k2 = makeKeyB64();
    const ring = Keyring.fromEnv(env({ ENCRYPTION_KEYS: `k1:${k1},k2:${k2}` }));

    expect(ring.all().map((e) => e.kid)).toEqual(['k1', 'k2']);
    expect(b64(ring.keyFor('k1')!.key)).toBe(k1);
    expect(b64(ring.keyFor('k2')!.key)).toBe(k2);
    expect(ring.keyFor('nope')).toBeUndefined();
  });

  it('skips blank and whitespace-only list segments', () => {
    const k1 = makeKeyB64();
    const k2 = makeKeyB64();
    const ring = Keyring.fromEnv(env({ ENCRYPTION_KEYS: ` k1:${k1} , ,,  , k2:${k2} ,` }));

    expect(ring.all().map((e) => e.kid)).toEqual(['k1', 'k2']);
    expect(b64(ring.keyFor('k2')!.key)).toBe(k2);
  });

  it('rejects a list entry missing its colon', () => {
    expectSecretBoxError(() => Keyring.fromEnv(env({ ENCRYPTION_KEYS: makeKeyB64() })), 'bad_key');
  });

  it('rejects a list entry with an empty kid', () => {
    expectSecretBoxError(
      () => Keyring.fromEnv(env({ ENCRYPTION_KEYS: `:${makeKeyB64()}` })),
      'bad_key',
    );
  });

  it('rejects a list entry with an empty value', () => {
    expectSecretBoxError(() => Keyring.fromEnv(env({ ENCRYPTION_KEYS: 'k1:' })), 'bad_key');
  });

  it('rejects a value that is not base64', () => {
    expectSecretBoxError(
      () => Keyring.fromEnv(env({ ENCRYPTION_KEYS: 'k1:not!valid!base64!' })),
      'bad_key',
    );
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    const short = b64(sodium.randombytes_buf(16));
    expectSecretBoxError(() => Keyring.fromEnv(env({ ENCRYPTION_KEYS: `k1:${short}` })), 'bad_key');
    expectSecretBoxError(() => Keyring.fromEnv(env({ ENCRYPTION_ACTIVE_KEY: short })), 'bad_key');
  });

  it('rejects an env with no keys at all', () => {
    expectSecretBoxError(() => Keyring.fromEnv(env({})), 'no_active_key');
    expectSecretBoxError(
      () => Keyring.fromEnv(env({ ENCRYPTION_KEYS: '  ', ENCRYPTION_ACTIVE_KEY: '  ' })),
      'no_active_key',
    );
  });

  it('rejects an ACTIVE_KID that names no configured key', () => {
    expectSecretBoxError(
      () =>
        Keyring.fromEnv(
          env({ ENCRYPTION_KEYS: `k1:${makeKeyB64()}`, ENCRYPTION_ACTIVE_KID: 'missing' }),
        ),
      'no_active_key',
    );
  });
});
