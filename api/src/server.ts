import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { loadEnv } from './env.js';
import { loggerOptions } from './util/log.js';
import { createDb } from './db/client.js';
import { Keyring } from './security/keyring.js';
import { runBootChecks } from './ops/boot-checks.js';
import { startAuthVerificationWorker } from './ops/auth-verification-worker.js';
import { attachShutdown } from './ops/shutdown.js';

import { envelopePlugin } from './http/plugins/envelope.js';
import { requestIdPlugin } from './http/plugins/request-id.js';
import { makeClientIpPlugin } from './http/plugins/client-ip.js';
import { makeRateLimiter, makeRateLimitPlugin } from './http/plugins/rate-limit.js';
import { makeAuthHostPlugin } from './http/plugins/auth-host.js';
import { makeAuthAdminPlugin } from './http/plugins/auth-admin.js';
import { authMtlsPlugin } from './http/plugins/auth-mtls.js';
import { corsPlugin } from './http/plugins/cors.js';

import { registerAllRoutes } from './routes/index.js';
import { registerWsServer } from './ws/server.js';

export async function buildServer() {
  const env = loadEnv();
  const { db, pool } = createDb(env);

  await runBootChecks(env, db);
  const keyring = Keyring.fromEnv(env);

  const app = Fastify({
    logger: loggerOptions(env),
    trustProxy: env.TRUST_X_FORWARDED,
    disableRequestLogging: false,
    bodyLimit: 32 * 1024 * 1024,
    ignoreTrailingSlash: true,
    caseSensitive: true,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length <= 128) return incoming;
      return undefined as unknown as string; // fastify will assign default
    },
  });

  // Decorate db + env + rate limiter on the instance so route modules can find them.
  app.decorate('db', db);
  app.decorate('env', env);
  app.decorate('keyring', keyring);
  app.decorate('rateLimiter', makeRateLimiter(db));

  // Plugins (order matters: cookies + cors + request-id + client-ip first; rate
  // limit + auth-mtls before auth-host/auth-admin; envelope last so it can
  // catch errors thrown by any of the above)
  await app.register(cookie, { hook: 'onRequest' });
  await app.register(corsPlugin);
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
  await app.register(requestIdPlugin);
  await app.register(makeClientIpPlugin(env));
  await app.register(authMtlsPlugin);
  await app.register(makeAuthHostPlugin(db));
  await app.register(makeAuthAdminPlugin(db, env));
  await app.register(makeRateLimitPlugin(env));
  await app.register(envelopePlugin);

  await registerAllRoutes(app, { db, env, keyring });
  await registerWsServer(app, env);
  startAuthVerificationWorker(app, env, db, keyring);

  attachShutdown(app, pool);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: ReturnType<typeof createDb>['db'];
    env: ReturnType<typeof loadEnv>;
    keyring: Keyring;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const env = loadEnv();
  const app = await buildServer();
  try {
    await app.listen({ host: env.LISTEN_HOST, port: env.LISTEN_PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}
