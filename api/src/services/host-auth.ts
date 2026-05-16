import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { hosts as hostsTable, type Host } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { ForbiddenError, UnauthorizedError } from '../http/errors.js';
import { extractApiKey, hashApiKey } from '../util/api-key-helpers.js';
import type { AuthFailureTracker } from './auth-failure-tracker.js';

/**
 * Host authentication helpers. Foundation already provides
 * `app.resolveHostFromKey` / `app.requireHost`; this service adds the
 * rate-limit + audit hooks the legacy PHP AuthService performed and exposes a
 * unified resolve that's reusable from cron/seed contexts.
 */
export interface HostAuthService {
  /**
   * Resolve a host by API key from a Fastify request. Records auth-fail
   * bucket hits on failure. Throws on missing/invalid/disabled host.
   */
  authenticate(req: FastifyRequest): Promise<Host>;
}

export interface HostAuthDeps {
  db: Database;
  failures: AuthFailureTracker;
}

export function createHostAuthService(deps: HostAuthDeps): HostAuthService {
  return {
    async authenticate(req) {
      const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
      const ip = req.clientIp || null;
      if (!key) {
        await deps.failures.recordFailure(ip, 'missing_api_key');
        throw new UnauthorizedError('API key missing', 'missing_api_key');
      }

      const hash = hashApiKey(key);
      const found = await deps.db
        .select()
        .from(hostsTable)
        .where(eq(hostsTable.apiKeyHash, hash))
        .limit(1);

      let host: Host | undefined = found[0];
      if (!host) {
        const legacy = await deps.db
          .select()
          .from(hostsTable)
          .where(eq(hostsTable.apiKey, key))
          .limit(1);
        host = legacy[0];
      }

      if (!host) {
        await deps.failures.recordFailure(ip, 'invalid_api_key');
        throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
      }
      if (host.status && host.status !== 'active') {
        throw new ForbiddenError(`Host ${host.status}`, `host_${host.status}`);
      }
      return host;
    },
  };
}
