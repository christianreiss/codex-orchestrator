import { describe, expect, it } from 'vitest';
import { inspectCredential } from '../../../src/services/auth-generation.js';
import { assessLoginExpiry } from '../../../src/services/login-expiry.js';

const now = Date.parse('2026-09-15T12:00:00Z');
const day = 86_400_000;
function assess(refresh: unknown, access: unknown = now + day) {
  return assessLoginExpiry(inspectCredential({ claudeAiOauth: {
    accessToken: 'test-access', refreshToken: 'test-refresh',
    expiresAt: access, refreshTokenExpiresAt: refresh,
  } }, 'claude'), now);
}

describe('Claude login expiry', () => {
  it.each([
    [3 * day + 1, 'ok', 4], [3 * day, 'expiring', 3],
    [day + 1, 'expiring', 2], [day, 'expiring', 1],
    [1, 'expiring', 1], [0, 'expired', 0], [-1, 'expired', 0],
  ])('assesses %i ms remaining', (remaining, state, days) => {
    expect(assess(now + remaining)).toEqual({ state, days_remaining: days, expires_at: new Date(now + remaining).toISOString() });
  });
  it.each([undefined, null, 'tomorrow', '1790000000000', NaN, Infinity, -1, 0])('treats missing/malformed expiry %s as unknown', (value) => {
    expect(assess(value)).toEqual({ state: 'unknown', days_remaining: null, expires_at: null });
  });
  it('matches the strict long-lived-access suppression boundary', () => {
    expect(assess(now + day, now + 4 * day).state).toBe('expiring');
    expect(assess(now + day, now + 4 * day + 1).state).toBe('not_applicable');
  });
  it('does not confuse expired access with expired login', () => {
    expect(assess(now + 10 * day, now - day).state).toBe('ok');
  });
  it('does not apply to API keys, Codex, or invent missing credentials', () => {
    expect(assessLoginExpiry(inspectCredential({ api_key: 'test-key' }, 'claude'), now).state).toBe('not_applicable');
    expect(assessLoginExpiry(inspectCredential({ tokens: { access_token: 'test' } }, 'codex'), now).state).toBe('not_applicable');
    expect(assessLoginExpiry(null, now).state).toBe('unknown');
  });
});
