import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { getTestDb } from '../../helpers/test-db.js';
import { testKeyring, loadTestEnv } from '../../helpers/test-keyring.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { registerAdminOpenAiKeyRoutes } from '../../../src/routes/admin/keys/openai.js';
import { registerAdminClaudeKeyRoutes } from '../../../src/routes/admin/keys/claude.js';
import { registerAdminGrokRoutes } from '../../../src/routes/admin/grok/index.js';
import { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { createClaudeKeyResolver } from '../../../src/services/claude-key-resolver.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Engine } from '../../../src/util/engine.js';

const handle = await getTestDb();
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

describe.skipIf(!handle)('per-key routing persistence against MySQL', () => {
  let app: FastifyInstance;
  let keys: OpenAiKeyService;
  const created: Array<{ id: number; engine: Engine }> = [];
  beforeAll(async () => {
    await sodium.ready;
    app = await buildRouteApp();
    const ctx = { db: handle!.db, keyring: testKeyring(), env: loadTestEnv() };
    keys = new OpenAiKeyService(ctx);
    await registerAdminOpenAiKeyRoutes(app, ctx);
    await registerAdminClaudeKeyRoutes(app, ctx);
    await registerAdminGrokRoutes(app, ctx);
  });
  afterAll(async () => {
    for (const row of created) await keys.delete(row.id, row.engine);
    await app?.close();
    await handle?.pool.end();
  });
  for (const namespace of ['openai', 'claude', 'grok']) {
    const engine = namespace === 'openai' ? 'codex' : namespace as Engine;
    for (const backend of [undefined, 'codex', 'claude', 'grok']) {
      it(`${namespace} persists ${backend ?? 'endpoint default'} through issuance, listing and authentication`, async () => {
        const reply = await app.inject({ method: 'POST', url: `/admin/${namespace}/keys`, payload: {
          name: `db-routing-${namespace}-${backend ?? 'legacy'}`, ...(backend ? { backend_engine: backend } : {}),
        } });
        expect(reply.statusCode, reply.body).toBe(200);
        const body = reply.json();
        created.push({ id: body.record.id, engine });
        expect(body.record.backend_engine).toBe(backend ?? null);
        const persisted = await keys.findById(body.record.id);
        expect(persisted).toMatchObject({ engine, backendEngine: backend ?? null });
        const list = (await app.inject(`/admin/${namespace}/keys`)).json().data;
        expect(list.find((row: { id: number }) => row.id === body.record.id)).toMatchObject({ backend_engine: backend ?? null });
        expect(JSON.stringify(list)).not.toContain(body.key);
        const authenticated = namespace === 'claude'
          ? await createClaudeKeyResolver(handle!.db).resolve({ headers: { 'x-api-key': body.key } } as unknown as FastifyRequest)
          : await keys.findActiveByBearer(body.key, engine);
        expect(authenticated?.backendEngine).toBe(backend ?? null);
        expect(await keys.findActiveByBearer(body.key, engine === 'codex' ? 'grok' : 'codex')).toBeNull();
      });
    }
  }
});
