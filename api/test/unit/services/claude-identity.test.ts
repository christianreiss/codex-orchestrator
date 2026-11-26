import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PROFILE_URL,
  claudeIdentityValue,
  lookupClaudeIdentity,
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

  it('tells a refused token from a lookup that failed', async () => {
    const answers: Record<string, () => Response | Promise<Response>> = {
      revoked: () => json({}, 401),
      forbidden: () => json({}, 403),
      limited: () => json({}, 429),
      broken: () => json({}, 502),
      partial: () => json({ account: { uuid: 'x' } }),
      offline: () => {
        throw new Error('offline');
      },
    };
    setClaudeIdentityFetch((async (_url: unknown, init?: { headers?: Record<string, string> }) =>
      answers[String(init?.headers?.Authorization).replace('Bearer sk-ant-oat01-', '')]!()) as unknown as typeof fetch);
    expect(await lookupClaudeIdentity('sk-ant-api03-key')).toEqual({ status: 'skipped' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-revoked')).toEqual({ status: 'unidentifiable' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-forbidden')).toEqual({ status: 'unidentifiable' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-limited')).toEqual({ status: 'unavailable', reason: 'http_429' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-broken')).toEqual({ status: 'unavailable', reason: 'http_502' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-partial')).toEqual({ status: 'unavailable', reason: 'profile_shape' });
    expect(await lookupClaudeIdentity('sk-ant-oat01-offline')).toEqual({ status: 'unavailable', reason: 'network' });
  });

  it('asks again soon after a failure, and keeps a refusal or rate limit for a minute', async () => {
    vi.useFakeTimers();
    try {
      let status = 502;
      const fetcher = vi.fn(async () => (status === 200 ? json(profile) : json({}, status)));
      setClaudeIdentityFetch(fetcher as unknown as typeof fetch);
      expect((await lookupClaudeIdentity('sk-ant-oat01-flaky')).status).toBe('unavailable');
      await lookupClaudeIdentity('sk-ant-oat01-flaky');
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(11_000);
      status = 200;
      expect((await lookupClaudeIdentity('sk-ant-oat01-flaky')).status).toBe('resolved');
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const refused of [401, 429]) {
        status = refused;
        const token = `sk-ant-oat01-slow-${refused}`;
        const before = fetcher.mock.calls.length;
        await lookupClaudeIdentity(token);
        vi.advanceTimersByTime(30_000);
        await lookupClaudeIdentity(token);
        expect(fetcher).toHaveBeenCalledTimes(before + 1);
        vi.advanceTimersByTime(31_000);
        await lookupClaudeIdentity(token);
        expect(fetcher).toHaveBeenCalledTimes(before + 2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls Anthropic from tests without an injected transport', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await resolveClaudeIdentity('sk-ant-oat01-real-looking')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
