import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  makeRateLimitPlugin,
  rateLimitBuckets,
  type RateLimitConfig,
  type RateLimiter,
} from '../../../src/http/plugins/rate-limit.js';
import { RateLimitedError } from '../../../src/http/errors.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';
import type { Env } from '../../../src/env.js';

/**
 * The global bucket is the only thing in front of every non-OPTIONS route, and
 * its exemptions are bare string prefixes: a typo or an over-broad entry in
 * BYPASS_PREFIXES hands a whole URL space an unmetered path. rate-limit-config
 * covers the counter itself, so these assertions pin what the preHandler does
 * around it — who it skips, what it keys on, and the 429 it raises.
 */

// Deliberately not the shipped defaults, so a preHandler that passed some other
// bucket's config through to hit() could not match by accident.
const ENV = {
  ...loadTestEnv(),
  RATE_LIMIT_GLOBAL_PER_MINUTE: 7,
  RATE_LIMIT_GLOBAL_WINDOW: 11,
} as Env;

const NOW = '2026-07-28T00:00:00.000Z';
const RESET_AT = '2026-07-28T00:00:30.000Z';
const CLIENT_IP = '203.0.113.7';
const METERED_URL = '/v1/chat/completions';

interface Probe {
  app: FastifyInstance;
  hits: Array<{ ip: string; bucket: string; overrides?: Partial<RateLimitConfig> }>;
  errors: unknown[];
}

/**
 * A Fastify instance carrying the plugin, a recording limiter and an error
 * handler that keeps whatever the hook threw (the wire shape of a 429 belongs
 * to the envelope plugin, which has its own suite).
 *
 * `clientIp` left out means the request was never decorated at all, which is
 * what the limiter sees when the client-ip plugin is not in the chain.
 */
async function buildProbe(
  opts: { clientIp?: string; ok?: boolean; resetAt?: string } = {},
): Promise<Probe> {
  const hits: Probe['hits'] = [];
  const errors: unknown[] = [];
  const app = Fastify({ logger: false });

  const rateLimiter: RateLimiter = {
    async hit(ip, bucket, overrides) {
      hits.push({ ip, bucket, overrides });
      return { ok: opts.ok ?? true, resetAt: opts.resetAt ?? RESET_AT, count: 8 };
    },
  };
  app.decorate('rateLimiter', rateLimiter);

  if (opts.clientIp !== undefined) {
    app.decorateRequest('clientIp', '');
    app.addHook('onRequest', async (req) => {
      req.clientIp = opts.clientIp!;
    });
  }

  await app.register(makeRateLimitPlugin(ENV));
  app.all('/*', async () => ({ ok: true }));
  app.setErrorHandler(async (err, _req, reply) => {
    errors.push(err);
    return reply.code(599).send({ handled: true });
  });
  await app.ready();
  return { app, hits, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('global rate-limit preHandler', () => {
  it('bypasses OPTIONS, health, WS upgrades and static admin assets', async () => {
    const { app, hits } = await buildProbe({ clientIp: CLIENT_IP });

    const bypassed = [
      '/healthz',
      '/admin/ws',
      '/admin/ws?token=abc123',
      '/admin/_app/x.js',
      '/admin/manual/articles/x',
      '/admin/favicon.ico',
    ];
    for (const url of bypassed) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    // A preflight against an otherwise metered route is exempt by method.
    const preflight = await app.inject({ method: 'OPTIONS', url: METERED_URL });
    expect(preflight.statusCode).toBe(200);

    expect(hits).toEqual([]);
    await app.close();
  });

  it('counts an ordinary request once, keyed by client IP, under the global bucket', async () => {
    const { app, hits } = await buildProbe({ clientIp: CLIENT_IP });

    const res = await app.inject({ method: 'GET', url: METERED_URL });

    expect(res.statusCode).toBe(200);
    expect(hits).toEqual([
      { ip: CLIENT_IP, bucket: 'global', overrides: { limit: 7, windowSeconds: 11 } },
    ]);
    expect(hits[0]!.overrides).toEqual(rateLimitBuckets(ENV).global);
    await app.close();
  });

  it('keys an unresolved client IP as 0.0.0.0 rather than skipping the bucket', async () => {
    const undecorated = await buildProbe();
    await undecorated.app.inject({ method: 'GET', url: METERED_URL });
    expect(undecorated.hits.map((h) => h.ip)).toEqual(['0.0.0.0']);
    await undecorated.app.close();

    const blank = await buildProbe({ clientIp: '' });
    await blank.app.inject({ method: 'GET', url: METERED_URL });
    expect(blank.hits.map((h) => h.ip)).toEqual(['0.0.0.0']);
    await blank.app.close();
  });

  it('throws RateLimitedError with the bucket, resetAt and remaining seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { app, errors } = await buildProbe({ clientIp: CLIENT_IP, ok: false });

    const res = await app.inject({ method: 'GET', url: METERED_URL });

    expect(res.statusCode).toBe(599);
    expect(errors).toHaveLength(1);
    const err = errors[0] as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.status).toBe(429);
    expect(err.extra).toEqual({ bucket: 'global', reset_at: RESET_AT });
    // RESET_AT is 30s past NOW, and Retry-After carries that verbatim.
    expect(err.headers).toEqual({ 'Retry-After': '30' });
    await app.close();
  });

  it('floors Retry-After at one second for an already-elapsed window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { app, errors } = await buildProbe({
      clientIp: CLIENT_IP,
      ok: false,
      resetAt: '2026-07-27T23:59:00.000Z',
    });

    await app.inject({ method: 'GET', url: METERED_URL });

    expect((errors[0] as RateLimitedError).headers).toEqual({ 'Retry-After': '1' });
    await app.close();
  });
});
