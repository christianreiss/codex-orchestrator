import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt, decrypt, isEnvelope, SecretBoxError } from '../../../src/security/secret-box.js';
import type { Env } from '../../../src/env.js';

const KEY_BYTES = 32;

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function makeKey(): Uint8Array {
  return sodium.randombytes_buf(KEY_BYTES);
}

function keyringFromKeys(keys: { kid: string; key: Uint8Array }[], activeKid: string): Keyring {
  const env = {
    ENCRYPTION_KEYS: keys.map((k) => `${k.kid}:${b64(k.key)}`).join(','),
    ENCRYPTION_ACTIVE_KID: activeKid,
  } as unknown as Env;
  return Keyring.fromEnv(env);
}

beforeAll(async () => {
  await sodium.ready;
});

describe('secret-box', () => {
  it('round-trips a string through the active key', () => {
    const key = makeKey();
    const ring = keyringFromKeys([{ kid: 'main', key }], 'main');
    const ct = encrypt('hello world', ring);
    expect(isEnvelope(ct)).toBe(true);
    expect(ct.startsWith('sbox:v1:kid=main:')).toBe(true);
    expect(decrypt(ct, ring)).toBe('hello world');
  });

  it('decrypts envelopes produced by a legacy (no-kid) PHP writer', () => {
    const legacyKey = makeKey();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(sodium.from_string('legacy-payload'), nonce, legacyKey);
    const combined = new Uint8Array(nonce.length + ct.length);
    combined.set(nonce, 0);
    combined.set(ct, nonce.length);
    const envelope = `sbox:v1:${b64(combined)}`;

    const ring = keyringFromKeys([{ kid: 'legacy', key: legacyKey }], 'legacy');
    expect(decrypt(envelope, ring)).toBe('legacy-payload');
  });

  it('finds the right key in a multi-key ring even when kid does not match', () => {
    const k1 = makeKey();
    const k2 = makeKey();
    const ringWriter = keyringFromKeys([{ kid: 'k2', key: k2 }], 'k2');
    const envelope = encrypt('hi', ringWriter);
    const ringReader = keyringFromKeys(
      [
        { kid: 'k1', key: k1 },
        { kid: 'k2', key: k2 },
      ],
      'k1',
    );
    expect(decrypt(envelope, ringReader)).toBe('hi');
  });

  it('throws SecretBoxError on tampered ciphertext', () => {
    const key = makeKey();
    const ring = keyringFromKeys([{ kid: 'k', key }], 'k');
    const envelope = encrypt('secret', ring);
    const idx = envelope.lastIndexOf(':');
    const tampered = envelope.slice(0, idx + 1) + 'AAAAAAAAAA';
    expect(() => decrypt(tampered, ring)).toThrow(SecretBoxError);
  });

  it('throws on a non-envelope string', () => {
    const key = makeKey();
    const ring = keyringFromKeys([{ kid: 'k', key }], 'k');
    expect(() => decrypt('not-an-envelope', ring)).toThrow(SecretBoxError);
  });
});
