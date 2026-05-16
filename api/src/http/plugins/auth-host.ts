import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { hosts as hostsTable } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { Host } from '../../db/schema.js';
import { UnauthorizedError } from '../errors.js';
import { extractApiKey, hashApiKey } from '../../util/api-key-helpers.js';

declare module 'fastify' {
  interface FastifyRequest {
    authHost?: Host;
  }
  interface FastifyInstance {
    requireHost: preHandlerHookHandler;
    resolveHostFromKey(req: FastifyRequest): Promise<Host | null>;
  }
}

export function makeAuthHostPlugin(db: Database) {
  return fp(
    async function authHostPlugin(app: FastifyInstance) {
      app.decorate('resolveHostFromKey', async (req: FastifyRequest): Promise<Host | null> => {
        const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
        if (!key) return null;
        const hash = hashApiKey(key);
        const rows = await db.select().from(hostsTable).where(eq(hostsTable.apiKeyHash, hash)).limit(1);
        if (rows[0]) return rows[0];
        // Fall back to legacy plaintext api_key column for hosts not yet hashed.
        const legacy = await db.select().from(hostsTable).where(eq(hostsTable.apiKey, key)).limit(1);
        return legacy[0] ?? null;
      });

      app.decorate('requireHost', async function requireHost(req: FastifyRequest) {
        const host = await app.resolveHostFromKey(req);
        if (!host) throw new UnauthorizedError('Invalid API key', 'invalid_api_key');
        if (host.status && host.status !== 'active') {
          throw new UnauthorizedError(`Host ${host.status}`, `host_${host.status}`);
        }
        req.authHost = host;
      });
    },
    { name: 'auth-host' },
  );
}
