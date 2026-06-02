import { describe, expect, it } from 'vitest';
import {
  createRunnerValidationService,
  extractAuthPayload,
} from '../../../src/services/runner-validation.js';
import { ValidationError } from '../../../src/http/errors.js';
import { sha256 } from '../../../src/security/hash.js';

// The pure functions on this service don't touch the DB.
const svc = createRunnerValidationService({ db: {} as any });

describe('runner-validation: ensureAuthsFallback', () => {
  it('passes through when auths is already present', () => {
    const r = svc.ensureAuthsFallback({ auths: { 'api.openai.com': { token: 't' } } }, 'codex');
    expect(r.auths).toEqual({ 'api.openai.com': { token: 't' } });
  });

  it('synthesises auths from tokens.access_token (codex only)', () => {
    const r = svc.ensureAuthsFallback({ tokens: { access_token: 'sk-...' } }, 'codex');
    expect((r.auths as Record<string, unknown>)['api.openai.com']).toMatchObject({
      token: 'sk-...',
      token_type: 'bearer',
    });
  });

  it('synthesises auths from OPENAI_API_KEY fallback', () => {
    const r = svc.ensureAuthsFallback({ OPENAI_API_KEY: 'sk-abc' }, 'codex');
    expect((r.auths as Record<string, unknown>)['api.openai.com']).toMatchObject({ token: 'sk-abc' });
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
      { auths: { 'api.anthropic.com': { token: 't', token_type: 'bearer' } } },
      'claude',
    );
    expect(r.auths).toEqual({ 'api.anthropic.com': { token: 't', token_type: 'bearer' } });
  });
});

describe('runner-validation: normalizeAuthEntries', () => {
  it('returns sorted entries with bearer default and meta passthrough', () => {
    const entries = svc.normalizeAuthEntries(
      {
        auths: {
          'b.example': { token: 'b' },
          'a.example': { token: 'a', token_type: 'oauth', organization: 'org', custom: 'meta-value' },
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
      { auths: { 'a.example': { token: '' }, 'b.example': { token: 'ok' } } },
      'codex',
    );
    expect(entries.map((e) => e.target)).toEqual(['b.example']);
  });
});

describe('runner-validation: canonicalize + digest', () => {
  it('produces a stable digest regardless of input key order', () => {
    const a = svc.canonicalizeAuthPayload(
      { auths: { 'a': { token: 't', extra: 1 }, 'b': { token: 't2' } }, tokens: { access_token: 'x' } },
      svc.normalizeAuthEntries({ auths: { 'b': { token: 't2' }, 'a': { token: 't', extra: 1 } } }, 'codex'),
      '2026-01-01T00:00:00Z',
    );
    const b = svc.canonicalizeAuthPayload(
      { auths: { 'b': { token: 't2' }, 'a': { token: 't', extra: 1 } }, tokens: { access_token: 'x' } },
      svc.normalizeAuthEntries({ auths: { 'a': { token: 't', extra: 1 }, 'b': { token: 't2' } } }, 'codex'),
      '2026-01-01T00:00:00Z',
    );
    const ea = JSON.stringify(a);
    const eb = JSON.stringify(b);
    expect(svc.calculateDigest(ea)).toBe(svc.calculateDigest(eb));
    expect(svc.calculateDigest(ea)).toBe(sha256(ea));
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
