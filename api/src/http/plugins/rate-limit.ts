import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { ipRateLimits } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import { RateLimitedError } from '../errors.js';
import type { Env } from '../../env.js';

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

const DEFAULTS: Record<string, RateLimitConfig> = {
  global: { limit: 120, windowSeconds: 60 },
  'auth-fail': { limit: 20, windowSeconds: 600 },
};

export interface RateLimiter {
  hit(
    ip: string,
    bucket: string,
    overrides?: Partial<RateLimitConfig>,
  ): Promise<{ ok: boolean; resetAt: string; count: number }>;
}

export function makeRateLimiter(db: Database): RateLimiter {
  return {
    async hit(ip, bucket, overrides) {
      const cfg = { ...(DEFAULTS[bucket] ?? DEFAULTS.global!), ...overrides };
      const now = new Date();
      const nowIso = now.toISOString();

      // Use atomic upsert: increment when row exists and not expired, else reset.
      // Drizzle MySQL doesn't have a clean ON DUPLICATE KEY UPDATE that
      // conditionally resets, so we do select-then-act under a small race window.
      const existing = await db
        .select()
        .from(ipRateLimits)
        .where(and(eq(ipRateLimits.ip, ip), eq(ipRateLimits.bucket, bucket)))
        .limit(1);

      const row = existing[0];
      if (!row || row.resetAt < nowIso) {
        const resetAt = new Date(now.getTime() + cfg.windowSeconds * 1000).toISOString();
        if (row) {
          await db
            .update(ipRateLimits)
            .set({ count: 1, resetAt, lastHit: nowIso })
            .where(eq(ipRateLimits.id, row.id));
        } else {
          await db.insert(ipRateLimits).values({
            ip,
            bucket,
            count: 1,
            resetAt,
            lastHit: nowIso,
            createdAt: nowIso,
          });
        }
        return { ok: true, resetAt, count: 1 };
      }

      if (row.count >= cfg.limit) {
        return { ok: false, resetAt: row.resetAt, count: row.count };
      }
      const nextCount = row.count + 1;
      await db
        .update(ipRateLimits)
        .set({ count: nextCount, lastHit: nowIso })
        .where(eq(ipRateLimits.id, row.id));
      return { ok: true, resetAt: row.resetAt, count: nextCount };
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimiter: RateLimiter;
  }
}

const BYPASS_PREFIXES = ['/admin/_app/', '/admin/manual/articles/', '/admin/favicon'];

export function makeRateLimitPlugin(_env: Env) {
  return fp(
    async function rateLimitPlugin(app: FastifyInstance) {
      app.addHook('preHandler', async (req: FastifyRequest) => {
        if (req.method === 'OPTIONS') return;
        if (req.url === '/healthz' || req.url.startsWith('/admin/ws')) return;
        for (const p of BYPASS_PREFIXES) if (req.url.startsWith(p)) return;
        const res = await app.rateLimiter.hit(req.clientIp || '0.0.0.0', 'global');
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

// Re-export defaults so other services can derive consistent values.
export const RATE_DEFAULTS = DEFAULTS;
