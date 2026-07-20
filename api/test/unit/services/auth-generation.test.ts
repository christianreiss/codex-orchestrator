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
    const older = inspectCredential({
      claudeAiOauth: {
        accessToken: 'access-a',
        refreshToken: 'refresh-a',
        expiresAt: Date.UTC(2026, 6, 20),
        refreshTokenExpiresAt: Date.UTC(2026, 7, 20),
      },
    }, 'claude');
    const newer = inspectCredential({
      claudeAiOauth: {
        accessToken: 'access-b',
        refreshToken: 'refresh-b',
        expiresAt: Date.UTC(2026, 6, 21),
        refreshTokenExpiresAt: Date.UTC(2026, 7, 20),
      },
    }, 'claude');
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    expect(compareCredentialFreshness(newer!, older!)).toBe(1);
    const metadata = credentialMetadata(older!, keyring.active());
    expect(metadata.pairFingerprint).toHaveLength(64);
    expect(pairFingerprints(older!, keyring).get('legacy')).toBe(metadata.pairFingerprint);
  });

  it('decodes Codex access-token JWT issue and expiry without trusting it as verification', () => {
    const payload = Buffer.from(JSON.stringify({ iat: 1_752_000_000, exp: 1_752_864_000 })).toString('base64url');
    const identity = inspectCredential({
      tokens: { access_token: `x.${payload}.sig`, refresh_token: 'refresh' },
    }, 'codex');
    expect(identity?.kind).toBe('codex_oauth');
    expect(identity?.issuedAt).toBe(new Date(1_752_000_000_000).toISOString());
    expect(identity?.accessExpiresAt).toBe(new Date(1_752_864_000_000).toISOString());
  });

  it('falls back to access-only identity for API keys', () => {
    const identity = inspectCredential({ OPENAI_API_KEY: 'sk-api-key' }, 'codex');
    expect(identity).toMatchObject({ kind: 'api_key', refresh: '', accessExpiresAt: null });
  });
});
