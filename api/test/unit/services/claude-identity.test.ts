import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PROFILE_URL,
  claudeIdentityValue,
  resolveClaudeIdentity,
  setClaudeIdentityFetch,
} from '../../../src/services/claude-identity.js';

const profile = { account: { uuid: 'acc-1', email: 'a@example.com' }, organization: { uuid: 'org-1', name: 'Org' } };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Claude identity lookup', () => {
  afterEach(() => setClaudeIdentityFetch(null));

  it('asks the OAuth profile endpoint with the access token and caches the answer', async () => {
    const fetcher = vi.fn(async () => json(profile));
    setClaudeIdentityFetch(fetcher as unknown as typeof fetch);
    const identity = await resolveClaudeIdentity('sk-ant-oat01-token');
    expect(identity).toEqual({ accountUuid: 'acc-1', organizationUuid: 'org-1', email: 'a@example.com', organizationName: 'Org' });
    expect(claudeIdentityValue(identity!)).toBe('acc-1:org-1');
    await resolveClaudeIdentity('sk-ant-oat01-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_PROFILE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-ant-oat01-token');
  });

  it('returns null for API keys, rejected tokens, malformed bodies and network errors', async () => {
    const fetcher = vi.fn(async () => json({}, 401));
    setClaudeIdentityFetch(fetcher as unknown as typeof fetch);
    expect(await resolveClaudeIdentity('sk-ant-api03-key')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await resolveClaudeIdentity('sk-ant-oat01-revoked')).toBeNull();
    setClaudeIdentityFetch((async () => json({ account: { uuid: 'x' } })) as unknown as typeof fetch);
    expect(await resolveClaudeIdentity('sk-ant-oat01-partial')).toBeNull();
    setClaudeIdentityFetch((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(await resolveClaudeIdentity('sk-ant-oat01-offline')).toBeNull();
  });

  it('never calls Anthropic from tests without an injected transport', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await resolveClaudeIdentity('sk-ant-oat01-real-looking')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
