import { describe, expect, it } from 'vitest';
import { Keyring } from '../../../src/security/keyring.js';
import {
  compareCredentialFreshness,
  credentialMetadata,
  inspectCredential,
  pairFingerprints,
} from '../../../src/services/auth-generation.js';

const key = Buffer.alloc(32, 7).toString('base64');
const keyring = Keyring.fromEnv({ AUTH_ENCRYPTION_KEY: key } as never);

describe('auth generation inspection', () => {
  it('uses Claude OAuth identity and native expiries', () => {
    const older = inspectCredential(
      {
        claudeAiOauth: {
          accessToken: 'access-a',
          refreshToken: 'refresh-a',
          expiresAt: Date.UTC(2026, 6, 20),
          refreshTokenExpiresAt: Date.UTC(2026, 7, 20),
        },
      },
      'claude',
    );
    const newer = inspectCredential(
      {
        claudeAiOauth: {
          accessToken: 'access-b',
          refreshToken: 'refresh-b',
          expiresAt: Date.UTC(2026, 6, 21),
          refreshTokenExpiresAt: Date.UTC(2026, 7, 20),
        },
      },
      'claude',
    );
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    expect(compareCredentialFreshness(newer!, older!)).toBe(1);
    const metadata = credentialMetadata(older!, keyring.active());
    expect(metadata.pairFingerprint).toHaveLength(64);
    expect(pairFingerprints(older!, keyring).get('legacy')).toBe(metadata.pairFingerprint);
  });

  it('decodes Codex access-token JWT issue and expiry without trusting it as verification', () => {
    const payload = Buffer.from(JSON.stringify({ iat: 1_752_000_000, exp: 1_752_864_000 })).toString(
      'base64url',
    );
    const identity = inspectCredential(
      {
        tokens: { access_token: `x.${payload}.sig`, refresh_token: 'refresh' },
      },
      'codex',
    );
    expect(identity?.kind).toBe('codex_oauth');
    expect(identity?.issuedAt).toBe(new Date(1_752_000_000_000).toISOString());
    expect(identity?.accessExpiresAt).toBe(new Date(1_752_864_000_000).toISOString());
  });

  it('falls back to access-only identity for API keys', () => {
    const identity = inspectCredential({ OPENAI_API_KEY: 'sk-api-key' }, 'codex');
    expect(identity).toMatchObject({ kind: 'api_key', refresh: '', accessExpiresAt: null });
  });

  it('matches native Codex auth_mode and OPENAI_API_KEY precedence', () => {
    const conflicting = {
      OPENAI_API_KEY: 'sk-native-api-key-winner',
      tokens: { access_token: 'native-chatgpt-oauth-loser', refresh_token: 'refresh-loser' },
      auths: { 'api.openai.com': { token: 'derived-loser' } },
    };
    expect(inspectCredential(conflicting, 'codex')).toMatchObject({
      kind: 'api_key',
      access: 'sk-native-api-key-winner',
    });
    expect(inspectCredential({ ...conflicting, auth_mode: 'chatgpt' }, 'codex')).toMatchObject({
      kind: 'codex_oauth',
      access: 'native-chatgpt-oauth-loser',
      refresh: 'refresh-loser',
    });
    expect(inspectCredential({ ...conflicting, auth_mode: 'apikey' }, 'codex')).toMatchObject({
      kind: 'api_key',
      access: 'sk-native-api-key-winner',
    });
  });

  it('rejects unsupported or incomplete explicit Codex auth modes', () => {
    expect(
      inspectCredential(
        {
          auth_mode: 'headers',
          OPENAI_API_KEY: 'sk-shadow-key',
          tokens: { access_token: 'shadow-oauth' },
        },
        'codex',
      ),
    ).toBeNull();
    expect(
      inspectCredential({ auth_mode: 'apikey', tokens: { access_token: 'shadow-oauth' } }, 'codex'),
    ).toBeNull();
    expect(inspectCredential({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-shadow-key' }, 'codex')).toBeNull();
  });

  it('classifies legacy Codex nested/auths keys only for server normalization', () => {
    expect(inspectCredential({ tokens: { openai_api_key: 'legacy-nested-key' } }, 'codex')).toMatchObject({
      kind: 'api_key',
      access: 'legacy-nested-key',
    });
    expect(
      inspectCredential({ auths: { 'api.openai.com': { token: 'legacy-auths-key' } } }, 'codex'),
    ).toMatchObject({ kind: 'api_key', access: 'legacy-auths-key' });
  });

  it('uses the same Claude API-key precedence as runtime projection', () => {
    const identity = inspectCredential(
      {
        api_key: 'sk-ant-api03-first-key',
        anthropic_api_key: 'sk-ant-api03-second-key',
        auths: { 'api.anthropic.com': { token: 'sk-ant-api03-derived-key' } },
      },
      'claude',
    );
    expect(identity).toMatchObject({
      kind: 'api_key',
      access: 'sk-ant-api03-first-key',
    });
  });

  it('does not classify an auths-only Claude OAuth projection as an API key', () => {
    expect(
      inspectCredential(
        { auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-derived-only-token' } } },
        'claude',
      ),
    ).toBeNull();
  });

  it.each([
    { api_key: 'sk-ant-oat01-top-level-projection' },
    { anthropic_api_key: 'sk-ant-oat01-top-level-projection' },
    { ANTHROPIC_API_KEY: 'sk-ant-oat01-top-level-projection' },
    { tokens: { anthropic_api_key: 'sk-ant-oat01-nested-projection' } },
    { tokens: { ANTHROPIC_API_KEY: 'sk-ant-oat01-nested-projection' } },
  ])('does not classify a Claude OAuth bearer in an API-key field: %j', (credential) => {
    expect(inspectCredential(credential, 'claude')).toBeNull();
  });
});
