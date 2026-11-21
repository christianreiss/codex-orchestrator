import { channel } from 'node:diagnostics_channel';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [output] = process.argv.slice(2);
if (!output || !process.env.TEST_DATABASE_URL || !process.env.DATA_ROOT || !process.env.ENCRYPTION_ACTIVE_KEY) {
  throw new Error('Supply an output path, TEST_DATABASE_URL, a disposable DATA_ROOT and its test ENCRYPTION_ACTIVE_KEY.');
}

// Use the same explicit test database as the repository's MySQL setup gate.
const db = new URL(process.env.TEST_DATABASE_URL);
if (db.protocol !== 'mysql:' || db.pathname.length < 2) throw new Error('A MySQL test schema is required.');
Object.assign(process.env, {
  NODE_ENV: 'test',
  DB_HOST: db.hostname,
  DB_PORT: db.port || '3306',
  DB_USERNAME: decodeURIComponent(db.username),
  DB_PASSWORD: decodeURIComponent(db.password),
  DB_DATABASE: decodeURIComponent(db.pathname.slice(1)),
  ADMIN_WS_ENABLED: process.env.ADMIN_WS_ENABLED || '1',
  CXX_COMMUNICATOR_ENABLED: '1',
  AUTH_RUNNER_URL: '',
});

const captured = [];
const initialization = channel('fastify.initialization');
Error.stackTraceLimit = 32;
function observe({ fastify }) {
  fastify.addHook('onRoute', options => {
    const frame = new Error().stack?.replaceAll('\\', '/').match(/\/(api\/src\/(?:routes|ws)\/[^):\n]+):(\d+)/);
    captured.push({ options, source: frame ? frame[1] + ':' + frame[2] : null });
  });
}
initialization.subscribe(observe);
let app;
try {
  const { buildServer } = await import('../../api/src/server.ts');
  const { guardForRoute } = await import('../../api/src/security/route-capabilities.ts');
  app = await buildServer();
  await app.ready();
  const registrations = captured.map(({ options, source }) => ({
    method: options.method,
    url: options.url,
    source,
    guard: guardForRoute(options.method, options.url),
    handlers: [options.preHandler].flat(Infinity).filter(Boolean).map(handler => handler.name || 'inline'),
    owner: options.config?.ownerResponse ?? null,
    websocket: options.websocket === true,
  }));
  await writeFile(resolve(output), JSON.stringify(registrations, null, 2) + '\n');
} finally {
  try { await app?.close(); } finally { initialization.unsubscribe(observe); }
}
