import type { FastifyInstance } from 'fastify';
import { RateLimitedError } from '../http/errors.js';
import { rateLimitBuckets } from '../http/plugins/rate-limit.js';

/**
 * Convenience wrapper around the global rate limiter for the `auth-fail`
 * bucket. The legacy PHP service throttles repeated bad API keys per IP.
 *
 * Limit and window come from `RATE_LIMIT_AUTH_FAIL_COUNT` /
 * `RATE_LIMIT_AUTH_FAIL_WINDOW`, whose defaults (20 failures / 600 seconds)
 * are the ones preserved from PHP.
 */
export interface AuthFailureTracker {
  /**
   * Records a failure. Throws RateLimitedError when the bucket is exhausted,
   * logging `reason` so a throttled IP shows what it was failing at.
   */
  recordFailure(ip: string | null | undefined, reason?: string): Promise<void>;
}

export function createAuthFailureTracker(app: FastifyInstance): AuthFailureTracker {
  return {
    async recordFailure(ip, reason) {
      if (!ip) return;
      const res = await app.rateLimiter.hit(ip, 'auth-fail', rateLimitBuckets(app.env)['auth-fail']);
      if (!res.ok) {
        const retryAfter = Math.max(1, Math.ceil((new Date(res.resetAt).getTime() - Date.now()) / 1000));
        app.log.warn({ ip, reason, bucket: 'auth-fail' }, 'auth failure rate limit exhausted');
        throw new RateLimitedError('Too many failed authentication attempts', {
          bucket: 'auth-fail',
          resetAt: res.resetAt,
          retryAfter,
        });
      }
    },
  };
}
