import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { envelopePlugin } from '../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../src/http/plugins/request-id.js';
import { makeClientIpPlugin } from '../../src/http/plugins/client-ip.js';
import { makeAuthHostPlugin } from '../../src/http/plugins/auth-host.js';
import { makeAuthAdminPlugin } from '../../src/http/plugins/auth-admin.js';
import { makeCapabilitiesPlugin } from '../../src/http/plugins/capabilities.js';
import { makeAuthMtlsPlugin } from '../../src/http/plugins/auth-mtls.js';
import { corsPlugin } from '../../src/http/plugins/cors.js';
import { notFoundHandler } from '../../src/http/not-found.js';
import type { Database } from '../../src/db/client.js';
import type { Env } from '../../src/env.js';
import { loadTestEnv, testKeyring } from './test-keyring.js';
import type { Keyring } from '../../src/security/keyring.js';

/**
 * Tests use this to mirror the production 404 envelope behavior. In a real
 * server, `registerAllRoutes` installs the shared not-found handler after the
 * static plugin; test apps don't run route registration, so they mount the
 * same handler here.
 */
function installTestNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(notFoundHandler);
}

/**
 * Lightweight app for plugin-level integration tests. No DB, no static, no WS.
 *
 * Use this when the test only exercises envelope/request-id behaviour.
 * For DB-backed integration tests use {@link buildAppWithDb}.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  installTestNotFoundHandler(app);
  return app;
}

export interface BuildAppOptions {
  env?: Partial<Env>;
  keyring?: Keyring;
  /** Skip registering auth plugins. Useful for narrow plugin tests. */
  minimal?: boolean;
}

/**
 * Build a Fastify app pre-wired with the same plugin stack as `src/server.ts`
 * (cookie, cors, multipart, request-id, client-ip, auth-mtls, auth-host,
 * auth-admin, capabilities, envelope) but without the static handler, route
 * registration, or WS server. Routes can be added by the caller via
 * `app.get(...)` etc. before invoking `inject()`.
 *
 * The plugin registration order matches production so guard hooks
 * (`requireAdmin`, `requireHost`), the capability guards attached at
 * registration time, and the envelope error handler behave exactly as they do
 * under `node dist/server.js`.
 *
 * That last part is load-bearing rather than incidental: a caller registering
 * a route under `/admin/` gets the same capability guard production would
 * attach, and the same refusal to serve it at all if the route carries no
 * entry in `security/route-capabilities.ts`.
 */
export async function buildAppWithDb(
  db: Database,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const env = { ...loadTestEnv(), ...(opts.env ?? {}) } as Env;
  const keyring = opts.keyring ?? testKeyring();

  const app = Fastify({
    logger: false,
    trustProxy: env.TRUST_X_FORWARDED,
    disableRequestLogging: true,
    bodyLimit: 32 * 1024 * 1024,
    ignoreTrailingSlash: true,
    caseSensitive: true,
  });

  app.decorate('db', db);
  app.decorate('env', env);
  app.decorate('keyring', keyring);

  await app.register(cookie, { hook: 'onRequest' });
  await app.register(corsPlugin);
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
  await app.register(requestIdPlugin);
  await app.register(makeClientIpPlugin(env));
  await app.register(makeAuthMtlsPlugin(env));
  if (!opts.minimal) {
    await app.register(makeAuthHostPlugin(db));
    await app.register(makeAuthAdminPlugin(db, env));
    // Authorization, not just authentication. Leaving this out gave a caller
    // that had authenticated as anyone the run of every governed route the
    // test registered afterwards, which is the one thing a DB-backed route
    // test is best placed to catch. It depends on `auth-admin`, so it belongs
    // inside this branch: a `minimal` app has no session to authorize.
    await app.register(makeCapabilitiesPlugin());
  }
  await app.register(envelopePlugin);
  installTestNotFoundHandler(app);

  return app;
}
