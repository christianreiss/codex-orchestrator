/**
 * Real-boot smoke test. Builds the production Fastify app with stub DB,
 * registers every Phase 2 route tree, lists every registered route, and
 * exercises representative endpoints across all four envelopes (standard /
 * openai / anthropic / static HTML) plus health and unmatched-route fallback.
 *
 * The DB is a tiny stub that returns `[]` for every Drizzle query — enough to
 * prove the route registration tree boots cleanly and the envelope plugin
 * dispatches correctly.
 *
 * Run with: pnpm tsx scripts/smoke.ts
 */

import { resolve } from 'node:path';

// Force a sane test env BEFORE loadEnv() runs.
process.env.ENCRYPTION_ACTIVE_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.DB_HOST ??= '127.0.0.1';
process.env.DB_PORT ??= '3306';
process.env.DB_DATABASE ??= 'smoke';
process.env.DB_USERNAME ??= 'smoke';
process.env.DB_PASSWORD ??= 'smoke';
process.env.NODE_ENV = 'development';
process.env.STATIC_ROOT ??= resolve(import.meta.dirname, '..', '..', 'public', 'admin');
process.env.LOG_LEVEL ??= 'error';
process.env.ADMIN_WS_ENABLED = '0';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { loadEnv } from '../src/env.js';
import { Keyring } from '../src/security/keyring.js';
import { envelopePlugin } from '../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../src/http/plugins/request-id.js';
import { makeClientIpPlugin } from '../src/http/plugins/client-ip.js';
import { makeAuthHostPlugin } from '../src/http/plugins/auth-host.js';
import { makeAuthAdminPlugin } from '../src/http/plugins/auth-admin.js';
import { makeAuthMtlsPlugin } from '../src/http/plugins/auth-mtls.js';
import { corsPlugin } from '../src/http/plugins/cors.js';
import { registerAllRoutes } from '../src/routes/index.js';
import type { Database } from '../src/db/client.js';

// Thenable Drizzle stub: every chain (.select().from().where()) returns Promise<[]>.
function makeStubDb(): Database {
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve([]);
      }
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  // Provide an `execute` that resolves so the boot-checks SELECT 1 passes.
  (proxy as { execute: () => Promise<unknown> }).execute = async () => [[{ '1': 1 }]];
  return proxy as Database;
}

async function main() {
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

  await app.register(cookie, { hook: 'onRequest' });
  await app.register(corsPlugin);
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
  await app.register(requestIdPlugin);
  await app.register(makeClientIpPlugin(env));
  await app.register(makeAuthMtlsPlugin(env));
  await app.register(makeAuthHostPlugin(db));
  await app.register(makeAuthAdminPlugin(db, env));
  await app.register(envelopePlugin);

  await registerAllRoutes(app, { db, env, keyring });
  await app.ready();

  // 1. Catalog every registered route.
  const routes = app.printRoutes({ commonPrefix: false }).split('\n').filter(Boolean);
  console.log(`# registered routes (${routes.length} lines)\n`);
  for (const r of routes) console.log('  ' + r);
  console.log();

  // 2. Hit representative endpoints across every envelope.
  const cases = [
    { method: 'GET', url: '/healthz', expect: 200, kind: 'standard' },
    { method: 'GET', url: '/readyz', expect: 200, kind: 'standard' },
    { method: 'GET', url: '/does/not/exist', expect: 404, kind: 'standard' },
    { method: 'POST', url: '/v1/chat/completions', expect: 401, kind: 'openai' },
    { method: 'GET', url: '/v1/models', expect: 401, kind: 'openai' },
    { method: 'POST', url: '/anthropic/v1/messages', expect: 401, kind: 'anthropic' },
    { method: 'GET', url: '/anthropic/v1/models', expect: 401, kind: 'anthropic' },
    { method: 'POST', url: '/auth', expect: 401, kind: 'standard' },
    { method: 'POST', url: '/sync/status', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/auth/status', expect: 200, kind: 'standard' },
    { method: 'POST', url: '/admin/auth/login', expect: 401, kind: 'standard', body: { username: 'x', password: 'y' } },
    { method: 'GET', url: '/admin/overview', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/usage', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/hosts', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/skills', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/projects', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/manual/manifest', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/openai/keys', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/claude/keys', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/ws/info', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/admin/api/state', expect: 401, kind: 'standard' },
    { method: 'POST', url: '/cli/auth/start', expect: 422, kind: 'standard', body: {} },
    { method: 'GET', url: '/wrapper/v2/meta', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/wrapper', expect: 401, kind: 'standard' },
    { method: 'POST', url: '/mcp', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/mcp', expect: 405, kind: 'standard' },
    { method: 'POST', url: '/projects', expect: 401, kind: 'standard' },
    { method: 'GET', url: '/versions', expect: 200, kind: 'standard' },
    { method: 'GET', url: '/admin', expect: 200, kind: 'html', acceptHtml: true },
    { method: 'GET', url: '/admin/hosts/123', expect: 200, kind: 'html', acceptHtml: true },
  ];

  console.log('# probe results\n');
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const headers: Record<string, string> = {};
    if (c.body) headers['content-type'] = 'application/json';
    if ((c as { acceptHtml?: boolean }).acceptHtml) headers['accept'] = 'text/html';
    const r = await app.inject({
      method: c.method as 'GET',
      url: c.url,
      payload: c.body,
      headers: Object.keys(headers).length ? headers : undefined,
    });

    const ct = r.headers['content-type'] ?? '';
    const okStatus =
      c.expect === r.statusCode ||
      // generous: 401/400/403/422 are all "auth/validation failed" for our purpose
      (c.expect === 401 && [400, 401, 403, 422].includes(r.statusCode)) ||
      (c.expect === 200 && r.statusCode === 200);

    let kindOk = true;
    if (c.kind === 'html') {
      kindOk = typeof ct === 'string' && ct.includes('text/html');
    } else if (typeof ct === 'string' && ct.includes('application/json') && r.payload) {
      try {
        const body = JSON.parse(r.payload);
        if (c.kind === 'standard') {
          if (r.statusCode >= 400) kindOk = body.status === 'error';
          else kindOk = body.status === 'ok' || body.ok === true || typeof body === 'object';
        } else if (c.kind === 'openai') {
          if (r.statusCode >= 400) kindOk = !!body.error && typeof body.error.message === 'string';
        } else if (c.kind === 'anthropic') {
          if (r.statusCode >= 400)
            kindOk = body.type === 'error' && !!body.error && typeof body.error.message === 'string';
        }
      } catch {
        kindOk = false;
      }
    }

    const label = `${c.method} ${c.url}`.padEnd(40);
    if (okStatus && kindOk) {
      console.log(`  ✓ ${label} → ${r.statusCode} (${c.kind})`);
      pass++;
    } else {
      console.log(`  ✗ ${label} → ${r.statusCode} (${c.kind}) [expected ${c.expect}]`);
      console.log(`     ct=${ct}`);
      console.log(`     body=${r.payload.slice(0, 140)}`);
      failures.push(label);
      fail++;
    }
  }

  console.log(`\n# summary: ${pass} pass / ${fail} fail / ${cases.length} total`);
  if (fail > 0) {
    console.log(`\n# failures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }

  await app.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(2);
});
