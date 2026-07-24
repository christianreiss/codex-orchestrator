import { describe, expect, it } from 'vitest';
import {
  createRunnerValidationService,
  extractAuthPayload,
  type CanonicalPayloadRow,
} from '../../../src/services/runner-validation.js';
import { ValidationError } from '../../../src/http/errors.js';
import { sha256 } from '../../../src/security/hash.js';
import { authCanonicalHeads, authPayloads } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { Keyring } from '../../../src/security/keyring.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { credentialMetadata, inspectCredential } from '../../../src/services/auth-generation.js';

// The pure functions on this service don't touch the DB.
const svc = createRunnerValidationService({ db: {} as any, tokenMinLength: 8 });

describe('runner-validation: ensureAuthsFallback', () => {
  it('passes through when auths is already present', () => {
    const r = svc.ensureAuthsFallback({ auths: { 'api.openai.com': { token: 'valid-token-123' } } }, 'codex');
    expect(r.auths).toEqual({
      'api.openai.com': { token: 'valid-token-123', token_type: 'bearer' },
    });
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

  it('projects the credential native Codex selects when OAuth and API key conflict', () => {
    const payload = {
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      tokens: { access_token: 'native-chatgpt-oauth-loser-123' },
      auths: { 'api.openai.com': { token: 'stale-derived-token-loser-123' } },
    };
    const inferred = svc.ensureAuthsFallback(payload, 'codex');
    expect((inferred.auths as Record<string, { token: string }>)['api.openai.com']?.token).toBe(
      'sk-native-api-key-winner-123',
    );

    const explicitChatGpt = svc.ensureAuthsFallback({ ...payload, auth_mode: 'chatgpt' }, 'codex');
    expect((explicitChatGpt.auths as Record<string, { token: string }>)['api.openai.com']?.token).toBe(
      'native-chatgpt-oauth-loser-123',
    );
  });

  it.each(['headers', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey', 'unknown'])(
    'rejects unsupported persisted Codex auth mode %s',
    (authMode) => {
      const projected = svc.ensureAuthsFallback(
        {
          auth_mode: authMode,
          OPENAI_API_KEY: 'sk-shadow-api-key-123',
          tokens: { access_token: 'shadow-oauth-access-token-123' },
          auths: { 'api.openai.com': { token: 'shadow-derived-token-123' } },
        },
        'codex',
      );
      expect(svc.hasUsableEngineCredential(projected, 'codex')).toBe(false);
    },
  );

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

  it.each([
    {
      engine: 'codex' as const,
      payload: {
        tokens: { access_token: 'sk-openai-native-oauth-token-123' },
        auths: { 'api.openai.com': { token: 'sk-openai-stale-derived-token-123' } },
      },
      target: 'api.openai.com',
      expected: 'sk-openai-native-oauth-token-123',
    },
    {
      engine: 'claude' as const,
      payload: {
        claudeAiOauth: { accessToken: 'sk-ant-oat01-native-oauth-token-123', refreshToken: 'refresh-123' },
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-stale-derived-token-123' } },
      },
      target: 'api.anthropic.com',
      expected: 'sk-ant-oat01-native-oauth-token-123',
    },
  ])('projects $engine native OAuth over a stale derived bearer', ({ engine, payload, target, expected }) => {
    const projected = svc.ensureAuthsFallback(payload, engine);
    expect((projected.auths as Record<string, { token: string }>)[target]?.token).toBe(expected);
  });

  it('does not rescue an empty Claude OAuth object with a stale derived bearer', () => {
    const projected = svc.ensureAuthsFallback(
      {
        claudeAiOauth: { accessToken: '', refreshToken: '' },
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-stale-derived-token-123' } },
      },
      'claude',
    );
    expect(svc.hasUsableEngineCredential(projected, 'claude')).toBe(false);
  });

  it('rejects an auths-only Claude OAuth projection without native OAuth', () => {
    const projected = svc.ensureAuthsFallback(
      {
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-derived-only-token-123' } },
      },
      'claude',
    );
    expect(svc.hasUsableEngineCredential(projected, 'claude')).toBe(false);
  });

  it('keeps a genuine Claude API key beside an empty OAuth object', () => {
    const projected = svc.ensureAuthsFallback(
      {
        claudeAiOauth: { accessToken: '', refreshToken: '' },
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-genuine-api-key-token-123' } },
      },
      'claude',
    );
    expect(svc.hasUsableEngineCredential(projected, 'claude')).toBe(true);
    expect((projected.auths as Record<string, { token: string }>)['api.anthropic.com']?.token).toBe(
      'sk-ant-api03-genuine-api-key-token-123',
    );
  });

  it('projects Claude credential precedence into one native auth entry', () => {
    const oauthWinner = svc.ensureAuthsFallback(
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-oauth-winner-token-123',
          refreshToken: 'oauth-winner-refresh',
        },
        api_key: 'sk-ant-api03-api-key-loser-token-123',
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-auths-loser-token-123' } },
      },
      'claude',
    );
    expect((oauthWinner.auths as Record<string, { token: string }>)['api.anthropic.com']?.token).toBe(
      'sk-ant-oat01-oauth-winner-token-123',
    );

    const apiKeyWinner = svc.ensureAuthsFallback(
      {
        api_key: 'sk-ant-api03-api-key-winner-token-123',
        anthropic_api_key: 'sk-ant-api03-secondary-key-loser-token-123',
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-auths-loser-token-123' } },
      },
      'claude',
    );
    expect((apiKeyWinner.auths as Record<string, { token: string }>)['api.anthropic.com']?.token).toBe(
      'sk-ant-api03-api-key-winner-token-123',
    );
  });

  it('rejects a higher-precedence invalid Claude API key instead of validating conflicting auths', () => {
    const projected = svc.ensureAuthsFallback(
      {
        api_key: 'invalid key with spaces',
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-valid-auths-loser-token-123' } },
      },
      'claude',
    );
    expect(svc.hasUsableEngineCredential(projected, 'claude')).toBe(false);
  });

  it.each([
    { api_key: 'sk-ant-oat01-top-level-projection-token-123' },
    { anthropic_api_key: 'sk-ant-oat01-top-level-projection-token-123' },
    { ANTHROPIC_API_KEY: 'sk-ant-oat01-top-level-projection-token-123' },
    { tokens: { anthropic_api_key: 'sk-ant-oat01-nested-projection-token-123' } },
    { tokens: { ANTHROPIC_API_KEY: 'sk-ant-oat01-nested-projection-token-123' } },
  ])('rejects an OAuth bearer stored in a Claude API-key field: %j', (credential) => {
    const projected = svc.ensureAuthsFallback(
      {
        ...credential,
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-valid-auths-loser-token-123' } },
      },
      'claude',
    );
    expect(svc.hasUsableEngineCredential(projected, 'claude')).toBe(false);
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
  it('retains only the engine-native entry with bearer default and meta passthrough', () => {
    const entries = svc.normalizeAuthEntries(
      {
        auths: {
          'unverified.example': { token: 'valid-unverified-token-123' },
          'api.openai.com': {
            token: 'valid-native-token-123',
            token_type: 'oauth',
            organization: 'org',
            custom: 'meta-value',
          },
        },
      },
      'codex',
    );
    expect(entries.map((e) => e.target)).toEqual(['api.openai.com']);
    expect(entries[0]!.tokenType).toBe('oauth');
    expect(entries[0]!.organization).toBe('org');
    expect(entries[0]!.meta).toEqual({ custom: 'meta-value' });
  });

  it('skips entries without a token', () => {
    const entries = svc.normalizeAuthEntries(
      {
        auths: {
          'api.openai.com': { token: '' },
          'unverified.example': { token: 'valid-unverified-token-123' },
        },
      },
      'codex',
    );
    expect(entries).toEqual([]);
  });

  it('filters whitespace, placeholder, short, and low-entropy tokens', () => {
    for (const token of ['valid token 123', 'placeholder', 'abc', 'aaaaaaaaaaaa']) {
      expect(
        svc.normalizeAuthEntries(
          {
            auths: {
              'api.openai.com': { token },
            },
          },
          'codex',
        ),
      ).toEqual([]);
    }
    expect(
      svc.normalizeAuthEntries(
        {
          auths: {
            'api.openai.com': { token: 'valid-high-entropy-token-123' },
          },
        },
        'codex',
      ),
    ).toMatchObject([{ target: 'api.openai.com' }]);
  });

  it('uses the documented 24-character default with an 8-character floor', () => {
    const strict = createRunnerValidationService({ db: {} as any, tokenMinLength: 24 });
    expect(
      strict.normalizeAuthEntries({ auths: { 'api.openai.com': { token: 'unique-but-under-24' } } }, 'codex'),
    ).toEqual([]);
    expect(
      strict.normalizeAuthEntries(
        {
          auths: {
            'api.openai.com': { token: 'unique-token-at-least-twenty-four-characters' },
          },
        },
        'codex',
      ),
    ).toHaveLength(1);
  });
});

describe('runner-validation: canonicalize + digest', () => {
  it('produces a stable native-only digest regardless of input key order', () => {
    const token = 'valid-openai-native-token-123';
    const a = svc.canonicalizeAuthPayload(
      {
        auth_mode: 'apikey',
        OPENAI_API_KEY: token,
        auths: {
          'unverified.example': { token: 'valid-unverified-token-123' },
          'api.openai.com': { token, organization: 'org' },
        },
      },
      svc.normalizeAuthEntries(
        {
          auths: {
            'api.openai.com': { organization: 'org', token },
            'unverified.example': { token: 'valid-unverified-token-123' },
          },
        },
        'codex',
      ),
      '2026-01-01T00:00:00Z',
      'codex',
    );
    const b = svc.canonicalizeAuthPayload(
      {
        auths: {
          'api.openai.com': { organization: 'org', token },
          'unverified.example': { token: 'valid-unverified-token-123' },
        },
        OPENAI_API_KEY: token,
        auth_mode: 'apikey',
      },
      svc.normalizeAuthEntries(
        {
          auths: {
            'unverified.example': { token: 'valid-unverified-token-123' },
            'api.openai.com': { token, organization: 'org' },
          },
        },
        'codex',
      ),
      '2026-01-01T00:00:00Z',
      'codex',
    );
    const ea = JSON.stringify(a);
    const eb = JSON.stringify(b);
    expect(svc.calculateDigest(ea)).toBe(svc.calculateDigest(eb));
    expect(svc.calculateDigest(ea)).toBe(sha256(ea));
    expect((a.auths as Record<string, unknown>)['unverified.example']).toBeUndefined();
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

  it('normalizes Claude output to one native credential and strips shadow credentials', () => {
    const conflicting = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-oauth-winner-token-123',
        refreshToken: 'oauth-refresh-token-123',
        expiresAt: 1_797_000_000_000,
      },
      api_key: 'sk-ant-api03-top-level-loser-token-123',
      anthropic_api_key: 'sk-ant-api03-alias-loser-token-123',
      ANTHROPIC_API_KEY: 'sk-ant-api03-env-loser-token-123',
      tokens: { anthropic_api_key: 'sk-ant-api03-nested-loser-token-123' },
      auths: { 'api.anthropic.com': { token: 'sk-ant-api03-derived-loser-token-123' } },
    };
    const oauthProjected = svc.ensureAuthsFallback(conflicting, 'claude');
    const oauthCanonical = svc.canonicalizeAuthPayload(
      oauthProjected,
      svc.normalizeAuthEntries(oauthProjected, 'claude'),
      '2026-01-01T00:00:00Z',
      'claude',
    );
    expect(oauthCanonical).toMatchObject({
      claudeAiOauth: conflicting.claudeAiOauth,
      auths: {
        'api.anthropic.com': { token: 'sk-ant-oat01-oauth-winner-token-123' },
      },
    });
    expect(oauthCanonical.api_key).toBeUndefined();
    expect(oauthCanonical.anthropic_api_key).toBeUndefined();
    expect(oauthCanonical.ANTHROPIC_API_KEY).toBeUndefined();
    expect(oauthCanonical.tokens).toBeUndefined();

    const apiKeyInput = {
      api_key: 'sk-ant-api03-top-level-winner-token-123',
      anthropic_api_key: 'sk-ant-api03-alias-loser-token-123',
      ANTHROPIC_API_KEY: 'sk-ant-api03-env-loser-token-123',
      tokens: { anthropic_api_key: 'sk-ant-api03-nested-loser-token-123' },
      auths: { 'api.anthropic.com': { token: 'sk-ant-api03-derived-loser-token-123' } },
    };
    const keyProjected = svc.ensureAuthsFallback(apiKeyInput, 'claude');
    const keyCanonical = svc.canonicalizeAuthPayload(
      keyProjected,
      svc.normalizeAuthEntries(keyProjected, 'claude'),
      '2026-01-01T00:00:00Z',
      'claude',
    );
    expect(keyCanonical).toMatchObject({
      api_key: 'sk-ant-api03-top-level-winner-token-123',
      auths: {
        'api.anthropic.com': { token: 'sk-ant-api03-top-level-winner-token-123' },
      },
    });
    expect(keyCanonical.claudeAiOauth).toBeUndefined();
    expect(keyCanonical.anthropic_api_key).toBeUndefined();
    expect(keyCanonical.ANTHROPIC_API_KEY).toBeUndefined();
    expect(keyCanonical.tokens).toBeUndefined();
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

  it('normalizes Codex output to one native auth mode and strips the shadow credential', () => {
    const conflicting = {
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      tokens: {
        access_token: 'native-chatgpt-oauth-loser-123',
        refresh_token: 'refresh-loser-123',
        openai_api_key: 'legacy-nested-loser-123',
      },
      auths: { 'api.openai.com': { token: 'stale-derived-token-loser-123' } },
    };
    const keyProjected = svc.ensureAuthsFallback(conflicting, 'codex');
    const keyCanonical = svc.canonicalizeAuthPayload(
      keyProjected,
      svc.normalizeAuthEntries(keyProjected, 'codex'),
      '2026-01-01T00:00:00Z',
      'codex',
    );
    expect(keyCanonical).toMatchObject({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      auths: {
        'api.openai.com': { token: 'sk-native-api-key-winner-123' },
      },
    });
    expect(keyCanonical.tokens).toBeUndefined();

    const oauthProjected = svc.ensureAuthsFallback({ ...conflicting, auth_mode: 'chatgpt' }, 'codex');
    const oauthCanonical = svc.canonicalizeAuthPayload(
      oauthProjected,
      svc.normalizeAuthEntries(oauthProjected, 'codex'),
      '2026-01-01T00:00:00Z',
      'codex',
    );
    expect(oauthCanonical).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'native-chatgpt-oauth-loser-123',
        refresh_token: 'refresh-loser-123',
      },
      auths: {
        'api.openai.com': { token: 'native-chatgpt-oauth-loser-123' },
      },
    });
    expect(oauthCanonical.OPENAI_API_KEY).toBeUndefined();
    expect((oauthCanonical.tokens as Record<string, unknown>).openai_api_key).toBeUndefined();
  });

  it('rewrites legacy Codex nested/auths-only keys to native API-key shape', () => {
    for (const payload of [
      { tokens: { openai_api_key: 'legacy-nested-api-key-123' } },
      { auths: { 'api.openai.com': { token: 'legacy-auths-api-key-123' } } },
    ]) {
      const projected = svc.ensureAuthsFallback(payload, 'codex');
      const canonical = svc.canonicalizeAuthPayload(
        projected,
        svc.normalizeAuthEntries(projected, 'codex'),
        '2026-01-01T00:00:00Z',
        'codex',
      );
      expect(canonical.auth_mode).toBe('apikey');
      expect(canonical.OPENAI_API_KEY).toBe(
        (canonical.auths as Record<string, { token: string }>)['api.openai.com']?.token,
      );
      expect(canonical.tokens).toBeUndefined();
    }
  });
});

describe('runner-validation: verified distribution safety', () => {
  function verifiedRow(
    auth: Record<string, unknown>,
    engine: CanonicalPayloadRow['engine'] = 'codex',
  ): CanonicalPayloadRow {
    const body = JSON.stringify(auth);
    return {
      id: 1,
      lastRefresh: String(auth.last_refresh),
      sha256: sha256(body),
      body,
      engine,
      createdAt: String(auth.last_refresh),
      verificationState: 'verified',
      verificationCheckedAt: String(auth.last_refresh),
      verificationReason: null,
    };
  }

  it('does not distribute a verified legacy shape native Codex cannot consume', () => {
    const auth = {
      last_refresh: '2026-07-24T07:00:00Z',
      auths: { 'api.openai.com': { token: 'legacy-auths-only-api-key-123' } },
    };
    const row = verifiedRow(auth);
    expect(svc.validateCanonicalPayload(row)).not.toBeNull();
    expect(svc.canonicalAuthFromPayload(row)).toBeNull();
  });

  it('does not distribute an old ambiguous OAuth/API-key row without matching fingerprints', () => {
    const auth = {
      last_refresh: '2026-07-24T07:00:00Z',
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      tokens: { access_token: 'old-runner-oauth-winner-123' },
      auths: { 'api.openai.com': { token: 'old-runner-oauth-winner-123' } },
    };
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth))).toBeNull();
  });

  it.each([
    {
      name: 'Codex API key versus stale derived bearer',
      engine: 'codex',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'sk-native-api-key-winner-123',
        auths: { 'api.openai.com': { token: 'sk-stale-derived-token-loser-123' } },
      },
    },
    {
      name: 'Codex ChatGPT OAuth versus stale derived bearer',
      engine: 'codex',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'native-chatgpt-oauth-winner-123',
          refresh_token: 'native-chatgpt-refresh-token-123',
        },
        auths: { 'api.openai.com': { token: 'sk-stale-derived-token-loser-123' } },
      },
    },
    {
      name: 'Claude API key versus stale derived bearer',
      engine: 'claude',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        api_key: 'sk-ant-api03-native-winner-token-123',
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-stale-loser-token-123' } },
      },
    },
    {
      name: 'Claude OAuth versus stale derived bearer',
      engine: 'claude',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-native-winner-token-123',
          refreshToken: 'native-refresh-token-123',
        },
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-stale-loser-token-123' } },
      },
    },
  ])('does not distribute $name', ({ auth, engine }) => {
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth, engine))).toBeNull();
  });

  it('keeps an exactly normalized native Codex row distributable', () => {
    const source = {
      last_refresh: '2026-07-24T07:00:00Z',
      tokens: { access_token: 'native-oauth-access-token-123', refresh_token: 'refresh-token-123' },
      auths: { 'api.openai.com': { token: 'native-oauth-access-token-123' } },
    };
    const projected = svc.ensureAuthsFallback(source, 'codex');
    const auth = svc.canonicalizeAuthPayload(
      projected,
      svc.normalizeAuthEntries(projected, 'codex'),
      source.last_refresh,
      'codex',
    );
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth))).toEqual(auth);
  });

  it('keeps an exactly normalized native Claude row distributable', () => {
    const apiKey = 'sk-ant-api03-native-matching-token-123';
    const source = {
      last_refresh: '2026-07-24T07:00:00Z',
      api_key: apiKey,
      auths: { 'api.anthropic.com': { token: apiKey } },
    };
    const projected = svc.ensureAuthsFallback(source, 'claude');
    const auth = svc.canonicalizeAuthPayload(
      projected,
      svc.normalizeAuthEntries(projected, 'claude'),
      source.last_refresh,
      'claude',
    );
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth, 'claude'))).toEqual(auth);
  });

  it.each([
    {
      name: 'Codex OAuth with an unverified API-key shadow',
      engine: 'codex',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'native-chatgpt-oauth-token-123',
          refresh_token: 'native-chatgpt-refresh-token-123',
        },
        OPENAI_API_KEY: 'sk-unverified-shadow-api-key-123',
        auths: {
          'api.openai.com': {
            token: 'native-chatgpt-oauth-token-123',
            token_type: 'bearer',
          },
        },
      },
    },
    {
      name: 'Claude OAuth with an unverified API-key shadow',
      engine: 'claude',
      auth: {
        last_refresh: '2026-07-24T07:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-native-oauth-token-123',
          refreshToken: 'native-refresh-token-123',
        },
        api_key: 'sk-ant-api03-unverified-shadow-token-123',
        auths: {
          'api.anthropic.com': {
            token: 'sk-ant-oat01-native-oauth-token-123',
            token_type: 'bearer',
          },
        },
      },
    },
  ])('withholds $name even when the selected and derived bearer match', ({ auth, engine }) => {
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth, engine))).toBeNull();
  });

  it('withholds a row carrying an unverified non-native auth target', () => {
    const token = 'sk-native-api-key-token-123';
    const auth = {
      last_refresh: '2026-07-24T07:00:00Z',
      auth_mode: 'apikey',
      OPENAI_API_KEY: token,
      auths: {
        'api.openai.com': { token, token_type: 'bearer' },
        'unverified.example': { token: 'unverified-extra-token-123', token_type: 'bearer' },
      },
    };
    expect(svc.canonicalAuthFromPayload(verifiedRow(auth))).toBeNull();
  });

  it('fails closed on partial or unverifiable credential fingerprint metadata', () => {
    const token = 'sk-ant-api03-native-matching-token-123';
    const source = {
      last_refresh: '2026-07-24T07:00:00Z',
      api_key: token,
      auths: { 'api.anthropic.com': { token } },
    };
    const projected = svc.ensureAuthsFallback(source, 'claude');
    const auth = svc.canonicalizeAuthPayload(
      projected,
      svc.normalizeAuthEntries(projected, 'claude'),
      source.last_refresh,
      'claude',
    );
    const partial = { ...verifiedRow(auth, 'claude'), fingerprintKid: 'legacy' };
    expect(svc.canonicalAuthFromPayload(partial)).toBeNull();

    const keyring = Keyring.fromEnv({
      ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    } as never);
    const identity = inspectCredential(auth, 'claude');
    expect(identity).not.toBeNull();
    const metadata = credentialMetadata(identity!, keyring.active());
    const complete = {
      ...verifiedRow(auth, 'claude'),
      fingerprintKid: metadata.fingerprintKid,
      pairFingerprint: metadata.pairFingerprint,
    };
    expect(svc.canonicalAuthFromPayload(complete)).toBeNull();
    const keyed = createRunnerValidationService({ db: {} as any, keyring, tokenMinLength: 8 });
    expect(keyed.canonicalAuthFromPayload(complete)).toEqual(auth);
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
      generation?: number;
    },
    kr: Keyring,
  ): Record<string, unknown> {
    const token = keys.rawToken ? keys.token : `valid-${keys.token}-token-123`;
    const engine = keys.engine ?? 'codex';
    const auth = {
      last_refresh: keys.stamp,
      auths: { [keys.target ?? 'api.openai.com']: { token, token_type: 'bearer' } },
      ...(engine === 'codex' && (keys.target ?? 'api.openai.com') === 'api.openai.com'
        ? { auth_mode: 'apikey', OPENAI_API_KEY: token }
        : {}),
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
      engine,
      generation: keys.generation ?? null,
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
    db.tables.set(authCanonicalHeads, [{ engine: 'codex', payloadId: 2, generation: 2 }]);
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

  it('keeps pending quarantine out of canonical resolution and exposes it for worker retry', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row(
        {
          id: 1,
          stamp: '2026-07-17T08:00:00Z',
          token: 'old',
          state: 'verified',
          generation: 1,
        },
        kr,
      ),
      row(
        {
          id: 2,
          stamp: '2026-07-17T09:00:00Z',
          token: 'new',
          state: 'pending',
          generation: 2,
        },
        kr,
      ),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(1);
    expect((await validation.resolvePendingQuarantine?.('codex'))?.id).toBe(2);
  });

  it('never retries an older pending row behind a newer failed quarantine generation', async () => {
    const db = createDbFake();
    const kr = keyring();
    db.tables.set(authPayloads, [
      row(
        {
          id: 1,
          stamp: '2026-07-17T08:00:00Z',
          token: 'head',
          state: 'verified',
          generation: 1,
        },
        kr,
      ),
      row(
        {
          id: 2,
          stamp: '2026-07-17T09:00:00Z',
          token: 'pending',
          state: 'pending',
          generation: 2,
        },
        kr,
      ),
      row(
        {
          id: 3,
          stamp: '2026-07-17T10:00:00Z',
          token: 'failed',
          state: 'failed',
          generation: 3,
        },
        kr,
      ),
    ]);
    db.tables.set(authCanonicalHeads, [{ engine: 'codex', payloadId: 1, generation: 1 }]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    expect(await validation.resolvePendingQuarantine?.('codex')).toBeNull();
  });

  it('returns canonical bytes only for verified rows', () => {
    const db = createDbFake();
    const kr = keyring();
    const validation = createRunnerValidationService({ db: db as never, keyring: kr });
    const verified = row(
      {
        id: 1,
        stamp: '2026-07-17T08:00:00Z',
        token: 'verified',
        state: 'verified',
      },
      kr,
    );
    const pending = row(
      {
        id: 2,
        stamp: '2026-07-17T09:00:00Z',
        token: 'pending',
        state: 'pending',
      },
      kr,
    );
    const failed = row(
      {
        id: 3,
        stamp: '2026-07-17T10:00:00Z',
        token: 'failed',
        state: 'failed',
      },
      kr,
    );
    expect(validation.canonicalAuthFromPayload(verified as never)).not.toBeNull();
    expect(validation.canonicalAuthFromPayload(pending as never)).toBeNull();
    expect(validation.canonicalAuthFromPayload(failed as never)).toBeNull();
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
      row(
        {
          id: 2,
          stamp: '2026-07-17T09:00:00Z',
          token: 'wrong-engine',
          state: 'verified',
          target: 'api.anthropic.com',
        },
        kr,
      ),
      row(
        {
          id: 3,
          stamp: '2026-07-17T10:00:00Z',
          token: 'aaaaaaaaaaaa',
          state: 'verified',
          rawToken: true,
        },
        kr,
      ),
    ]);
    const validation = createRunnerValidationService({ db: db as never, keyring: kr, tokenMinLength: 8 });
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(1);
  });
});
