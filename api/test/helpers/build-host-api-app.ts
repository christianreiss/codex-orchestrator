import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../src/http/plugins/request-id.js';
import type { Database } from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import { Keyring } from '../../src/security/keyring.js';
import { registerHostApiRoutes } from '../../src/routes/host-api/index.js';
import { extractApiKey, hashApiKey } from '../../src/util/api-key-helpers.js';
import type { Host, AdminUser, AdminSession } from '../../src/db/schema.js';

/**
 * A minimal app suitable for testing host-api routes without a live MySQL.
 * Pass a `db` fake that returns the rows you want; pass `keyring` for crypto.
 */
export interface HostApiTestAppOptions {
  db: Database;
  env: Env;
  keyring: Keyring;
}

export async function buildHostApiTestApp(opts: HostApiTestAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);

  // Decorate db / env / keyring on the instance so the route modules find them.
  app.decorate('db', opts.db);
  app.decorate('env', opts.env);
  app.decorate('keyring', opts.keyring);

  // clientIp test adapter (foundation plugin requires onRequest hooks we skip here).
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => {
    req.clientIp = (req.headers['x-test-ip'] as string) || '127.0.0.1';
  });

  // Cheap auth-host/auth-admin test adapters that just call into the db so the route
  // modules can re-resolve when they need to. Most route handlers in host-api
  // own their own resolution, so these are mostly placeholders.
  app.decorate('resolveHostFromKey', async (req: FastifyRequest): Promise<Host | null> => {
    const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
    if (!key) return null;
    const hash = hashApiKey(key);
    const { hosts } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await opts.db.select().from(hosts).where(eq(hosts.apiKeyHash, hash)).limit(1);
    return rows[0] ?? null;
  });
  app.decorate('requireHost', async function (req: FastifyRequest) {
    const host = await app.resolveHostFromKey(req);
    if (!host) throw new Error('host not resolved');
    req.authHost = host;
  });
  app.decorate('resolveAdmin', async (_req: FastifyRequest) => null as
    | { user: AdminUser; session: AdminSession }
    | null);
  app.decorate('requireAdmin', async function (_req: FastifyRequest) {
    // Tests inject an admin session via x-test-admin header.
    const adminId = _req.headers['x-test-admin-id'];
    if (!adminId) {
      const err: Error & { statusCode?: number } = new Error('admin required');
      err.statusCode = 401;
      throw err;
    }
    _req.admin = {
      user: {
        id: Number(adminId),
        name: 'Test Admin',
        username: 'admin',
        email: 'admin@test',
        passwordHash: '',
        accessLevel: 'admin',
        active: 1,
        lastLoginAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      session: {} as AdminSession,
    };
  });

  await app.register(envelopePlugin);
  await registerHostApiRoutes(app, { db: opts.db, env: opts.env, keyring: opts.keyring });

  return app;
}
