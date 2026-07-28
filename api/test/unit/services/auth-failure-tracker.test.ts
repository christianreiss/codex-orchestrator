import { afterEach, describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAuthFailureTracker, type AuthFailureTracker } from '../../../src/services/auth-failure-tracker.js';
import { rateLimitBuckets, type RateLimitConfig, type RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import { RateLimitedError } from '../../../src/http/errors.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';
import type { Env } from '../../../src/env.js';

/**
 * Three auth route modules call `recordFailure` after a bad credential, so this
 * is the per-IP brute-force throttle in its entirety: skipping the limiter for
 * an unknown IP, charging the `auth-fail` bucket rather than the global one,
 * and turning an exhausted bucket into the 429 the routes propagate.
 */

// Deliberately not the shipped defaults, so a tracker reaching for the global
// bucket's config could not match by accident.
const ENV = {
  ...loadTestEnv(),
  RATE_LIMIT_AUTH_FAIL_COUNT: 3,
  RATE_LIMIT_AUTH_FAIL_WINDOW: 900,
} as Env;

const NOW = '2026-07-28T00:00:00.000Z';
const RESET_AT = '2026-07-28T00:00:45.000Z';
const CLIENT_IP = '203.0.113.7';

interface Probe {
  tracker: AuthFailureTracker;
  hits: Array<{ ip: string; bucket: string; overrides?: Partial<RateLimitConfig> }>;
}

function setup(opts: { ok?: boolean; resetAt?: string } = {}): Probe {
  const hits: Probe['hits'] = [];
  const rateLimiter: RateLimiter = {
    async hit(ip, bucket, overrides) {
      hits.push({ ip, bucket, overrides });
      return { ok: opts.ok ?? true, resetAt: opts.resetAt ?? RESET_AT, count: 4 };
    },
  };
  const app = { env: ENV, rateLimiter } as unknown as FastifyInstance;
  return { tracker: createAuthFailureTracker(app), hits };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('auth failure tracker', () => {
  it('does not touch the limiter when the caller has no IP', async () => {
    const { tracker, hits } = setup();

    await expect(tracker.recordFailure(null, 'password_reset_failed')).resolves.toBeUndefined();
    await expect(tracker.recordFailure(undefined)).resolves.toBeUndefined();
    await expect(tracker.recordFailure('')).resolves.toBeUndefined();

    expect(hits).toEqual([]);
  });

  it('charges the auth-fail bucket and resolves while it has room', async () => {
    const { tracker, hits } = setup();

    await expect(tracker.recordFailure(CLIENT_IP, 'passkey_login_failed')).resolves.toBeUndefined();

    expect(hits).toEqual([
      { ip: CLIENT_IP, bucket: 'auth-fail', overrides: { limit: 3, windowSeconds: 900 } },
    ]);
    expect(hits[0]!.overrides).toEqual(rateLimitBuckets(ENV)['auth-fail']);
  });

  it('throws RateLimitedError with the bucket, resetAt and remaining seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { tracker } = setup({ ok: false });

    const err = await tracker.recordFailure(CLIENT_IP).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitedError);
    const rateLimited = err as RateLimitedError;
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.extra).toEqual({ bucket: 'auth-fail', reset_at: RESET_AT });
    // RESET_AT is 45s past NOW, and Retry-After carries that verbatim.
    expect(rateLimited.headers).toEqual({ 'Retry-After': '45' });
  });

  it('floors Retry-After at one second for an already-elapsed window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { tracker } = setup({ ok: false, resetAt: '2026-07-27T23:59:00.000Z' });

    const err = await tracker.recordFailure(CLIENT_IP).catch((e: unknown) => e);

    expect((err as RateLimitedError).headers).toEqual({ 'Retry-After': '1' });
  });
});
