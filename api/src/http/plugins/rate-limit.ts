import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { ipRateLimits } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { RateLimitedError } from '../errors.js';
import { loadEnv, type Env } from '../../env.js';

/**
 * Reads/writes the existing `ip_rate_limits` table verbatim. Per-IP per-bucket
 * counter with a TTL window. The `auth-fail` bucket is consumed only from
 * within auth services (call `recordAuthFailure(...)` after a bad credential).
 *
 * Global bucket runs on every non-OPTIONS request, with a soft bypass list for
 * static admin assets, WS upgrades, and the health endpoint.
 */

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

/**
 * Bucket configuration as the operator tuned it. Unknown buckets fall back to
 * the global one.
 */
export function rateLimitBuckets(env: Env): Record<string, RateLimitConfig> {
  return {
    global: {
      limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
      windowSeconds: env.RATE_LIMIT_GLOBAL_WINDOW,
    },
    'auth-fail': {
      limit: env.RATE_LIMIT_AUTH_FAIL_COUNT,
      windowSeconds: env.RATE_LIMIT_AUTH_FAIL_WINDOW,
    },
  };
}

export interface RateLimiter {
  hit(
    ip: string,
    bucket: string,
    overrides?: Partial<RateLimitConfig>,
  ): Promise<{ ok: boolean; resetAt: string; count: number }>;
}

export function makeRateLimiter(db: Database, env: Env = loadEnv()): RateLimiter {
  const buckets = rateLimitBuckets(env);
  return {
    async hit(ip, bucket, overrides) {
      const cfg = { ...(buckets[bucket] ?? buckets.global!), ...overrides };
      const now = new Date();
      const nowIso = now.toISOString();
      const windowResetAt = new Date(now.getTime() + cfg.windowSeconds * 1000).toISOString();

      // Atomic upsert: MySQL serializes concurrent INSERT ... ON DUPLICATE KEY
      // UPDATE against the same (ip, bucket) row (backed by uniq_ip_bucket), so
      // unlike the previous select-then-update this can't lose hits under
      // concurrency. Reset the counter when the window has expired, otherwise
      // increment it in place.
      await db.execute(sql`
        INSERT INTO ip_rate_limits (ip, bucket, count, reset_at, last_hit, created_at)
        VALUES (${ip}, ${bucket}, 1, ${windowResetAt}, ${nowIso}, ${nowIso})
        ON DUPLICATE KEY UPDATE
          count = IF(reset_at < ${nowIso}, 1, count + 1),
          reset_at = IF(reset_at < ${nowIso}, ${windowResetAt}, reset_at),
          last_hit = ${nowIso}
      `);

      const rows = await db
        .select()
        .from(ipRateLimits)
        .where(and(eq(ipRateLimits.ip, ip), eq(ipRateLimits.bucket, bucket)))
        .limit(1);
      const row = rows[0]!;

      if (row.count > cfg.limit) {
        return { ok: false, resetAt: row.resetAt, count: row.count };
      }
      return { ok: true, resetAt: row.resetAt, count: row.count };
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimiter: RateLimiter;
  }
}

const BYPASS_PREFIXES = ['/admin/_app/', '/admin/manual/articles/', '/admin/favicon'];

export function makeRateLimitPlugin(env: Env) {
  const global = rateLimitBuckets(env).global!;
  return fp(
    async function rateLimitPlugin(app: FastifyInstance) {
      app.addHook('preHandler', async (req: FastifyRequest) => {
        if (req.method === 'OPTIONS') return;
        if (req.url === '/healthz' || req.url.startsWith('/admin/ws')) return;
        for (const p of BYPASS_PREFIXES) if (req.url.startsWith(p)) return;
        const res = await app.rateLimiter.hit(req.clientIp || '0.0.0.0', 'global', global);
        if (!res.ok) {
          const retryAfter = Math.max(1, Math.ceil((new Date(res.resetAt).getTime() - Date.now()) / 1000));
          throw new RateLimitedError('Rate limit exceeded', {
            bucket: 'global',
            resetAt: res.resetAt,
            retryAfter,
          });
        }
      });
    },
    { name: 'rate-limit' },
  );
}

