/**
 * Same harness as scripts/smoke.ts but actually listens on a TCP port and
 * lets you curl against it. Exits after a short wait. Stubs the DB.
 */
import { resolve } from 'node:path';

process.env.ENCRYPTION_ACTIVE_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '3306';
process.env.DB_DATABASE ??= 'smoke';
process.env.DB_USERNAME ??= 'smoke';
process.env.DB_PASSWORD ??= 'smoke';
process.env.NODE_ENV = 'development';
process.env.STATIC_ROOT ??= resolve(import.meta.dirname, '..', '..', 'public', 'admin');
process.env.LOG_LEVEL ??= 'warn';
process.env.ADMIN_WS_ENABLED = '0';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { loadEnv } from '../src/env.js';
import { Keyring } from '../src/security/keyring.js';
import { envelopePlugin } from '../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../src/http/plugins/request-id.js';
import { makeClientIpPlugin } from '../src/http/plugins/client-ip.js';
import { makeRateLimiter, makeRateLimitPlugin } from '../src/http/plugins/rate-limit.js';
import { makeAuthHostPlugin } from '../src/http/plugins/auth-host.js';
import { makeAuthAdminPlugin } from '../src/http/plugins/auth-admin.js';
import { authMtlsPlugin } from '../src/http/plugins/auth-mtls.js';
import { corsPlugin } from '../src/http/plugins/cors.js';
import { registerAllRoutes } from '../src/routes/index.js';
import type { Database } from '../src/db/client.js';

function makeStubDb(): Database {
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve([]);
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  (proxy as { execute: () => Promise<unknown> }).execute = async () => [[{ '1': 1 }]];
  return proxy as Database;
}

const env = loadEnv();
const keyring = Keyring.fromEnv(env);
const db = makeStubDb();

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
app.decorate('rateLimiter', makeRateLimiter(db));

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

const port = Number(process.env.LISTEN_PORT ?? 8195);
await app.listen({ host: '127.0.0.1', port });
console.log(`listening on http://127.0.0.1:${port}`);

setTimeout(() => {
  void app.close().then(() => process.exit(0));
}, Number(process.env.UPTIME_MS ?? 6000));
