import { expect, it } from 'vitest';
import { rescueAccess, isRescueMediaHost } from '../../../src/services/rescue-identity.js';

it('projects access credentials without refresh tokens or unrelated account fields', () => {
  const tokens = { access_token: 'access', refresh_token: 'private', id_token: 'id' };
  expect(rescueAccess('codex', { tokens, OPENAI_API_KEY: 'private' })).toEqual({ access_token: 'access', id_token: 'id' });
  expect(rescueAccess('claude', { claudeAiOauth: { accessToken: 'access', refreshToken: 'private' } })).toEqual({ access_token: 'access' });
  expect(() => rescueAccess('codex', null)).toThrow();
});

it('reserves only named non-VIP insecure media', () => {
  for (const fqdn of ['rescue-owl', 'rescue-dalason']) {
    expect(isRescueMediaHost({ fqdn, secure: 0, vip: 0 })).toBe(true);
    expect(isRescueMediaHost({ fqdn, secure: 1, vip: 0 })).toBe(false);
    expect(isRescueMediaHost({ fqdn, secure: 0, vip: 1 })).toBe(false);
  }
  expect(isRescueMediaHost({ fqdn: 'ordinary-host', secure: 0, vip: 0 })).toBe(false);
});
