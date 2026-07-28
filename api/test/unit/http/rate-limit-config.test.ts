import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeRateLimiter, rateLimitBuckets, type RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import { resetEnvCache, type Env } from '../../../src/env.js';
import { loadTestEnv } from '../../helpers/test-keyring.js';
import type { Database } from '../../../src/db/client.js';

/**
 * The RATE_LIMIT_* knobs are the only thing an operator can reach for when a
 * legitimate burst trips the buckets, so these assertions pin that they are
 * actually wired to the limiter, that the shipped defaults are the documented
 * ones, and that docs never advertise a knob the Env schema doesn't parse.
 */

const RATE_LIMIT_KEYS = [
  'RATE_LIMIT_GLOBAL_PER_MINUTE',
  'RATE_LIMIT_GLOBAL_WINDOW',
  'RATE_LIMIT_AUTH_FAIL_COUNT',
  'RATE_LIMIT_AUTH_FAIL_WINDOW',
];

/** Parses the Env with the given RATE_LIMIT_* overrides applied (absent = unset). */
function envWith(overrides: Record<string, string | undefined>): Env {
  const saved = new Map<string, string | undefined>();
  for (const key of RATE_LIMIT_KEYS) {
    saved.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  try {
    return loadTestEnv();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  }
}

/**
 * Stands in for the `ip_rate_limits` round-trip: one counter row that the
 * upsert bumps and the follow-up select reads back. Each limiter under test
 * only ever touches a single (ip, bucket) pair, so one counter is enough.
 */
function stubDb(): Database {
  let count = 0;
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    async execute() {
      count += 1;
      return [[], []];
    },
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ count, resetAt }] }),
      }),
    }),
  } as unknown as Database;
}

/** Ordinal of the first hit reported as `ok:false`, i.e. limit + 1. */
async function firstBlockedHit(limiter: RateLimiter, bucket: string, ceiling: number): Promise<number> {
  for (let i = 1; i <= ceiling; i += 1) {
    const res = await limiter.hit('203.0.113.7', bucket);
    if (!res.ok) return i;
  }
  return -1;
}

describe('rate limit env configuration', () => {
  it('applies non-default env values to both buckets', async () => {
    const env = envWith({
      RATE_LIMIT_GLOBAL_PER_MINUTE: '3',
      RATE_LIMIT_GLOBAL_WINDOW: '15',
      RATE_LIMIT_AUTH_FAIL_COUNT: '2',
      RATE_LIMIT_AUTH_FAIL_WINDOW: '90',
    });

    expect(rateLimitBuckets(env)).toEqual({
      global: { limit: 3, windowSeconds: 15 },
      'auth-fail': { limit: 2, windowSeconds: 90 },
    });
    expect(await firstBlockedHit(makeRateLimiter(stubDb(), env), 'global', 10)).toBe(4);
    expect(await firstBlockedHit(makeRateLimiter(stubDb(), env), 'auth-fail', 10)).toBe(3);
  });

  it('defaults to 120/60 for the global bucket and 20/600 for auth-fail', async () => {
    const env = envWith({});

    expect(env.RATE_LIMIT_GLOBAL_PER_MINUTE).toBe(120);
    expect(env.RATE_LIMIT_GLOBAL_WINDOW).toBe(60);
    expect(env.RATE_LIMIT_AUTH_FAIL_COUNT).toBe(20);
    expect(env.RATE_LIMIT_AUTH_FAIL_WINDOW).toBe(600);
    expect(rateLimitBuckets(env)).toEqual({
      global: { limit: 120, windowSeconds: 60 },
      'auth-fail': { limit: 20, windowSeconds: 600 },
    });
    expect(await firstBlockedHit(makeRateLimiter(stubDb(), env), 'global', 200)).toBe(121);
    expect(await firstBlockedHit(makeRateLimiter(stubDb(), env), 'auth-fail', 50)).toBe(21);
  });

  it('documents only RATE_LIMIT_* names the Env schema parses', () => {
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
    const env = envWith({});
    const documented = new Set<string>();
    for (const doc of ['docs/SECURITY.md', 'docs/API.md', 'docs/interface-api.md']) {
      const text = readFileSync(resolve(repoRoot, doc), 'utf8');
      for (const match of text.matchAll(/RATE_LIMIT_[A-Z0-9_]+/g)) documented.add(match[0]);
    }

    expect(documented.size).toBeGreaterThan(0);
    expect([...documented].filter((name) => !(name in env))).toEqual([]);
  });
});
