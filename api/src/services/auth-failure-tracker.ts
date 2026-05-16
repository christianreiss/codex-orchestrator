import type { FastifyInstance } from 'fastify';
import { RateLimitedError } from '../http/errors.js';

/**
 * Convenience wrapper around the global rate limiter for the `auth-fail`
 * bucket. The legacy PHP service throttles repeated bad API keys per IP.
 *
 * Defaults preserved from PHP:
 *   limit  = 20 failures
 *   window = 600 seconds (10 minutes)
 */
export interface AuthFailureTracker {
  /**
   * Records a failure, returns rate state. Throws RateLimitedError when the
   * bucket is exhausted.
   */
  recordFailure(ip: string | null | undefined, reason?: string): Promise<void>;
}

export function createAuthFailureTracker(app: FastifyInstance): AuthFailureTracker {
  return {
    async recordFailure(ip, _reason) {
      if (!ip) return;
      const res = await app.rateLimiter.hit(ip, 'auth-fail', {
        limit: 20,
        windowSeconds: 600,
      });
      if (!res.ok) {
        const retryAfter = Math.max(1, Math.ceil((new Date(res.resetAt).getTime() - Date.now()) / 1000));
        throw new RateLimitedError('Too many failed authentication attempts', {
          bucket: 'auth-fail',
          resetAt: res.resetAt,
          retryAfter,
        });
      }
    },
  };
}
