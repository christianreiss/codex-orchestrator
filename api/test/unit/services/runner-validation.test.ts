import { describe, expect, it } from 'vitest';
import {
  createRunnerValidationService,
  extractAuthPayload,
} from '../../../src/services/runner-validation.js';
import { ValidationError } from '../../../src/http/errors.js';
import { sha256 } from '../../../src/security/hash.js';
import { authCanonicalHeads, authPayloads } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';

// The pure functions on this service don't touch the DB.
const svc = createRunnerValidationService({ db: {} as any, tokenMinLength: 8 });

describe('runner-validation: ensureAuthsFallback', () => {
  it('passes through when auths is already present', () => {
    const r = svc.ensureAuthsFallback({ auths: { 'api.openai.com': { token: 'valid-token-123' } } }, 'codex');
    expect(r.auths).toEqual({ 'api.openai.com': { token: 'valid-token-123' } });
  });

  it('synthesises auths from tokens.access_token (codex only)', () => {
    const r = svc.ensureAuthsFallback({ tokens: { access_token: 'sk-valid-openai-123' } }, 'codex');
    expect((r.auths as Record<string, unknown>)['api.openai.com']).toMatchObject({
      token: 'sk-valid-openai-123',
      token_type: 'bearer',
    });
  });

  it('synthesises auths from OPENAI_API_KEY fallback', () => {
    const r = svc.ensureAuthsFallback({ OPENAI_API_KEY: 'sk-valid-api-key-123' }, 'codex');
    expect((r.auths as Record<string, unknown>)['api.openai.com']).toMatchObject({
      token: 'sk-valid-api-key-123',
    });
  });

  it('does not synthesise for claude engine from codex-style tokens', () => {
    const r = svc.ensureAuthsFallback({ tokens: { access_token: 'foo' } }, 'claude');
    expect(r.auths).toBeUndefined();
  });

  it('maps a Claude.ai OAuth credentials.json onto the anthropic bearer entry', () => {
    const r = svc.ensureAuthsFallback(
      { claudeAiOauth: { accessToken: 'sk-ant-oat-xyz', refreshToken: 'r', expiresAt: 1 } },
      'claude',
    );
    expect(r.auths).toEqual({
      'api.anthropic.com': { token: 'sk-ant-oat-xyz', token_type: 'bearer' },
    });
    // And those normalise into a usable entry (the seed/upload path requires ≥1).
    const entries = svc.normalizeAuthEntries(r, 'claude');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.target).toBe('api.anthropic.com');
    expect(entries[0]!.token).toBe('sk-ant-oat-xyz');
  });

  it('leaves claude auths{} untouched when already present', () => {
    const r = svc.ensureAuthsFallback(
      { auths: { 'api.anthropic.com': { token: 'valid-token-123', token_type: 'bearer' } } },
      'claude',
    );
    expect(r.auths).toEqual({ 'api.anthropic.com': { token: 'valid-token-123', token_type: 'bearer' } });
  });

  it('repairs empty or wrong-target auths from native Codex credentials without dropping extras', () => {
    const r = svc.ensureAuthsFallback(
      {
        auths: { 'internal.example': { token: 'valid-extra-token-123' } },
        tokens: { access_token: 'sk-valid-openai-fallback-123' },
      },
      'codex',
    );
    expect(r.auths).toMatchObject({
      'internal.example': { token: 'valid-extra-token-123' },
      'api.openai.com': { token: 'sk-valid-openai-fallback-123' },
    });
  });

  it.each(['api_key', 'anthropic_api_key', 'ANTHROPIC_API_KEY'])(
    'synthesises Claude auths from %s',
    (key) => {
      const r = svc.ensureAuthsFallback({ auths: {}, [key]: 'sk-ant-api03-valid-fallback-123' }, 'claude');
      expect(r.auths).toMatchObject({
        'api.anthropic.com': { token: 'sk-ant-api03-valid-fallback-123' },
      });
    },
  );

  it.each(['anthropic_api_key', 'ANTHROPIC_API_KEY'])(
    'synthesises Claude auths from legacy tokens.%s',
    (key) => {
      const r = svc.ensureAuthsFallback(
        { tokens: { [key]: 'sk-ant-api03-valid-nested-fallback-123' } },
        'claude',
      );
      expect(r.auths).toMatchObject({
        'api.anthropic.com': { token: 'sk-ant-api03-valid-nested-fallback-123' },
      });
    },
  );
});

describe('runner-validation: normalizeAuthEntries', () => {
  it('returns sorted entries with bearer default and meta passthrough', () => {
    const entries = svc.normalizeAuthEntries(
      {
        auths: {
          'b.example': { token: 'valid-b-token-123' },
          'a.example': { token: 'valid-a-token-123', token_type: 'oauth', organization: 'org', custom: 'meta-value' },
        },
      },
      'codex',
    );
    expect(entries.map((e) => e.target)).toEqual(['a.example', 'b.example']);
    expect(entries[0]!.tokenType).toBe('oauth');
    expect(entries[0]!.organization).toBe('org');
    expect(entries[0]!.meta).toEqual({ custom: 'meta-value' });
    expect(entries[1]!.tokenType).toBe('bearer');
  });

  it('skips entries without a token', () => {
    const entries = svc.normalizeAuthEntries(
      { auths: { 'a.example': { token: '' }, 'b.example': { token: 'valid-ok-token-123' } } },
      'codex',
    );
    expect(entries.map((e) => e.target)).toEqual(['b.example']);
  });

  it('filters whitespace, placeholder, short, and low-entropy tokens', () => {
    const entries = svc.normalizeAuthEntries(
      {
        auths: {
          whitespace: { token: 'valid token 123' },
          placeholder: { token: 'placeholder' },
          short: { token: 'abc' },
          repeated: { token: 'aaaaaaaaaaaa' },
          valid: { token: 'valid-high-entropy-token-123' },
        },
      },
      'codex',
    );
    expect(entries.map((entry) => entry.target)).toEqual(['valid']);
  });

  it('uses the documented 24-character default with an 8-character floor', () => {
    const strict = createRunnerValidationService({ db: {} as any, tokenMinLength: 24 });
    expect(
      strict.normalizeAuthEntries({ auths: { short: { token: 'unique-but-under-24' } } }, 'codex'),
    ).toEqual([]);
    expect(
      strict.normalizeAuthEntries(
        { auths: { valid: { token: 'unique-token-at-least-twenty-four-characters' } } },
        'codex',
      ),
    ).toHaveLength(1);
  });
});

describe('runner-validation: canonicalize + digest', () => {
  it('produces a stable digest regardless of input key order', () => {
    const a = svc.canonicalizeAuthPayload(
      { auths: { a: { token: 'valid-a-token-123', extra: 1 }, b: { token: 'valid-b-token-123' } }, tokens: { access_token: 'x' } },
      svc.normalizeAuthEntries({ auths: { b: { token: 'valid-b-token-123' }, a: { token: 'valid-a-token-123', extra: 1 } } }, 'codex'),
      '2026-01-01T00:00:00Z',
    );
    const b = svc.canonicalizeAuthPayload(
      { auths: { b: { token: 'valid-b-token-123' }, a: { token: 'valid-a-token-123', extra: 1 } }, tokens: { access_token: 'x' } },
      svc.normalizeAuthEntries({ auths: { a: { token: 'valid-a-token-123', extra: 1 }, b: { token: 'valid-b-token-123' } } }, 'codex'),
      '2026-01-01T00:00:00Z',
    );
    const ea = JSON.stringify(a);
    const eb = JSON.stringify(b);
    expect(svc.calculateDigest(ea)).toBe(svc.calculateDigest(eb));
    expect(svc.calculateDigest(ea)).toBe(sha256(ea));
  });

  it('preserves the native claudeAiOauth account-login object (1:1 with codex tokens)', () => {
    const oauth = {
      accessToken: 'sk-ant-oat01-abc',
      refreshToken: 'r',
      expiresAt: 123,
      scopes: ['user:inference'],
    };
    const withFallback = svc.ensureAuthsFallback({ claudeAiOauth: oauth }, 'claude');
    const canonical = svc.canonicalizeAuthPayload(
      withFallback,
      svc.normalizeAuthEntries(withFallback, 'claude'),
      '2026-01-01T00:00:00Z',
    );
    // The native object survives canonicalization with refreshToken/expiresAt/scopes
    // intact — so the host receives a real .credentials.json, not just a bearer.
    expect(canonical.claudeAiOauth).toEqual(oauth);
    // The derived auths bearer is still present for server-side/proxy use.
    const bearer = (canonical.auths as Record<string, { token: string }>)['api.anthropic.com'];
    expect(bearer?.token).toBe('sk-ant-oat01-abc');
  });

  it('does not invent a claudeAiOauth key for codex payloads', () => {
    const canonical = svc.canonicalizeAuthPayload(
      { auths: { 'api.openai.com': { token: 'valid-openai-token-123' } }, tokens: { access_token: 'x' } },
      svc.normalizeAuthEntries({ auths: { 'api.openai.com': { token: 'valid-openai-token-123' } } }, 'codex'),
      '2026-01-01T00:00:00Z',
    );
    expect(canonical.claudeAiOauth).toBeUndefined();
    expect(canonical.tokens).toEqual({ access_token: 'x' });
  });
});

describe('runner-validation: extractAuthPayload', () => {
  it('returns payload.auth when present', () => {
    expect(extractAuthPayload({ auth: { last_refresh: 'x' } })).toEqual({ last_refresh: 'x' });
  });
  it('returns root when last_refresh is at root', () => {
    expect(extractAuthPayload({ last_refresh: 'y' })).toEqual({ last_refresh: 'y' });
  });
  it('throws otherwise', () => {
    expect(() => extractAuthPayload({})).toThrow(ValidationError);
  });
});

describe('runner-validation: canonical resolution', () => {
  function keyring(): Keyring {
    return Keyring.fromEnv({
      ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    } as never);
  }

  function row(
    keys: {
      id: number;
      stamp: string;
      token: string;
      state: string;
      target?: string;
      engine?: string;
      rawToken?: boolean;
    },
    kr: Keyring,
  ): Record<string, unknown> {
    const token = keys.rawToken ? keys.token : `valid-${keys.token}-token-123`;
    const auth = {
      last_refresh: keys.stamp,
      auths: { [keys.target ?? 'api.openai.com']: { token, token_type: 'bearer' } },
    };
    const body = JSON.stringify(auth);
    return {
      id: keys.id,
      lastRefresh: keys.stamp,
      sha256: sha256(body),
      sourceHostId: null,
      createdAt: keys.stamp,
      body: encrypt(body, kr),
      verificationState: keys.state,
      verificationCheckedAt: keys.stamp,
      verificationReason: keys.state === 'failed' ? 'expired' : null,
      engine: keys.engine ?? 'codex',
    };
  }

  it('orders RFC3339 offsets by their actual instant', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row({ id: 1, stamp: '2026-07-17T10:30:00+02:00', token: 'older', state: 'verified' }, kr),
      row({ id: 2, stamp: '2026-07-17T09:00:00Z', token: 'newer', state: 'verified' }, kr),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
  });

  it('does not resurrect an older verified row after the newer lineage failed', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row({ id: 1, stamp: '2026-07-17T08:00:00Z', token: 'old', state: 'verified' }, kr),
      row({ id: 2, stamp: '2026-07-17T09:00:00Z', token: 'new', state: 'failed' }, kr),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
  });

  it('does not bypass an invalid explicit canonical head with valid history', async () => {
    const db = createDbFake();
    const kr = keyring();
    const valid = row({ id: 1, stamp: '2026-07-17T08:00:00Z', token: 'old', state: 'verified' }, kr);
    const corruptHead = row({ id: 2, stamp: '2026-07-17T09:00:00Z', token: 'new', state: 'verified' }, kr);
    corruptHead.sha256 = '0'.repeat(64);
    db.tables.set(authPayloads, [valid, corruptHead]);
    db.tables.set(authCanonicalHeads, [{ engine: 'codex', payloadId: 2, generation: 2 }]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    const selected = await validation.resolveCanonicalPayload('codex');
    expect(selected?.id).toBe(2);
    expect(validation.validateCanonicalPayload(selected)).toBeNull();
  });

  it('keeps a newer pending upload visible instead of falling back to historical verified auth', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row({ id: 1, stamp: '2026-07-17T08:00:00Z', token: 'old', state: 'verified' }, kr),
      row({ id: 2, stamp: '2026-07-17T09:00:00Z', token: 'new', state: 'pending' }, kr),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
  });

  it('rejects corrupt digest/timestamp/token rows and falls back to a valid row', async () => {
    const db = createDbFake();
    const kr = keyring();
    const valid = row({ id: 1, stamp: '2026-07-17T08:00:00Z', token: 'old', state: 'verified' }, kr);
    const corrupt = row({ id: 2, stamp: '2026-07-17T09:00:00Z', token: 'new', state: 'verified' }, kr);
    corrupt.sha256 = '0'.repeat(64);
    db.tables.set(authPayloads, [valid, corrupt]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(1);
  });

  it('skips future/ancient generations instead of letting them poison monotonic ordering', async () => {
    const db = createDbFake();
    const kr = keyring();
    const validStamp = new Date(Date.now() - 10 * 60_000).toISOString();
    const futureStamp = new Date(Date.now() + 10 * 60_000).toISOString();
    db.tables.set(authPayloads, [
      row({ id: 1, stamp: validStamp, token: 'valid', state: 'verified' }, kr),
      row({ id: 2, stamp: futureStamp, token: 'future', state: 'verified' }, kr),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr, tokenMinLength: 8 });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(1);

    db.tables.set(authPayloads, [
      row({ id: 3, stamp: '1999-12-31T23:59:59Z', token: 'ancient', state: 'verified' }, kr),
    ]);
    expect(await validation.resolveCanonicalPayload('codex')).toBeNull();
  });

  it('skips wrong-engine-only and low-quality rows', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row({ id: 1, stamp: '2026-07-17T08:00:00Z', token: 'native', state: 'verified' }, kr),
      row({
        id: 2,
        stamp: '2026-07-17T09:00:00Z',
        token: 'wrong-engine',
        state: 'verified',
        target: 'api.anthropic.com',
      }, kr),
      row({
        id: 3,
        stamp: '2026-07-17T10:00:00Z',
        token: 'aaaaaaaaaaaa',
        state: 'verified',
        rawToken: true,
      }, kr),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr, tokenMinLength: 8 });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(1);
  });
});
