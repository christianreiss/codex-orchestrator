import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { loadEnv } from './env.js';
import { loggerOptions } from './util/log.js';
import { createDb } from './db/client.js';
import { Keyring } from './security/keyring.js';
import { runBootMigrations } from './ops/boot-migrations.js';
import { runBootChecks } from './ops/boot-checks.js';
import { retireManagedContextRow } from './ops/retire-context-skill.js';
import { startAuthVerificationWorker } from './ops/auth-verification-worker.js';
import { startAuthRetentionWorker } from './ops/auth-retention-worker.js';
import { startMattPocockSkillsWorker } from './ops/mattpocock-skills-worker.js';
import { startAgentPortalWorker } from './ops/agent-portal-worker.js';
import { startAgentMessagingWorker } from './ops/agent-messaging-worker.js';
import { attachShutdown } from './ops/shutdown.js';
import { MattPocockSkillsService } from './services/mattpocock-skills.js';

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

  // Schema first: the boot checks below probe tables that migrations create.
  await runBootMigrations(env, pool);
  await runBootChecks(env, db);
  // Must run before the first /skills request of this process: `context` is no
  // longer served as a managed skill, so any surviving legacy row would stop
  // being shadowed and start being handed to the fleet. Idempotent, and a
  // failure must not keep the whole API down over one stale row — but it does
  // need to be loud, because the failure mode is silently serving stale doctrine.
  await retireManagedContextRow(db)
    .then((outcome) => {
      if (outcome.reason === 'tombstoned') console.warn('[boot] retired legacy #context skill row');
      else if (outcome.reason === 'left_alone') {
        console.warn('[boot] a non-legacy `context` skill row exists and is now served; verify this is intended');
      }
    })
    .catch((err) => {
      console.warn(`[boot] could not retire legacy #context skill row: ${String(err)}`);
    });
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
  startAuthRetentionWorker(app, db);
  startMattPocockSkillsWorker(app, new MattPocockSkillsService(db));
  startAgentPortalWorker(app, db, env, keyring);
  startAgentMessagingWorker(app, db, env, keyring);

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
  let app: Awaited<ReturnType<typeof buildServer>>;
  try {
    app = await buildServer();
  } catch (err) {
    // Node prints the offending source line with the stack; for `dist/server.js`
    // that is a screenful of minified bundle around the real reason. Boot
    // failures (a migration that will not apply, most likely) get one line.
    process.stderr.write(`[boot] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  try {
    await app.listen({ host: env.LISTEN_HOST, port: env.LISTEN_PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}
