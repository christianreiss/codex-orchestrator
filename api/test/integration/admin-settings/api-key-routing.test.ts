import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { openaiApiKeys, versions } from '../../../src/db/schema.js';
import { registerAdminOpenAiKeyRoutes } from '../../../src/routes/admin/keys/openai.js';
import { registerAdminClaudeKeyRoutes } from '../../../src/routes/admin/keys/claude.js';
import { registerAdminGrokRoutes } from '../../../src/routes/admin/grok/index.js';
import { createClaudeKeyResolver } from '../../../src/services/claude-key-resolver.js';
import { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { sha256 } from '../../../src/security/hash.js';
import type { FastifyRequest } from 'fastify';
import type { RouteContext } from '../../../src/routes/index.js';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');
beforeAll(async () => { await sodium.ready; });

async function harness() {
  const app = await buildRouteApp();
  const db = createDbFake(new Map([[versions, [{ name: 'grok_engine_disabled', version: '1' }]]]));
  const ctx = { db, keyring: testKeyring(), env: {} } as unknown as RouteContext;
  await registerAdminOpenAiKeyRoutes(app, ctx);
  await registerAdminClaudeKeyRoutes(app, ctx);
  await registerAdminGrokRoutes(app, ctx);
  return { app, db, ctx };
}

describe('per-key engine creation across API formats', () => {
  for (const namespace of ['openai', 'claude', 'grok']) {
    it(`${namespace}: persists the assigned engine in creation, listing and authentication`, async () => {
      const { app, db, ctx } = await harness();
      try {
        const reply = await app.inject({ method: 'POST', url: `/admin/${namespace}/keys`, payload: { name: 'independent', backend_engine: 'claude' } });
        expect(reply.statusCode, reply.body).toBe(200);
        const body = reply.json();
        expect(body.record).toMatchObject({ backend_engine: 'claude', name: 'independent' });
        const stored = db.tables.get(openaiApiKeys)![0]!;
        expect(stored).toMatchObject({ backendEngine: 'claude', engine: namespace === 'openai' ? 'codex' : namespace });
        expect(stored.keyHash).toBe(sha256(body.key));
        const list = await app.inject(`/admin/${namespace}/keys`);
        expect(list.json().data[0]).toMatchObject({ backend_engine: 'claude' });
        expect(list.body).not.toContain(body.key);
        if (namespace === 'claude') {
          const resolved = await createClaudeKeyResolver(ctx.db).resolve({ headers: { 'x-api-key': body.key } } as unknown as FastifyRequest);
          expect(resolved.backendEngine).toBe('claude');
        } else {
          const resolved = await new OpenAiKeyService({ db: ctx.db, keyring: ctx.keyring }).findActiveByBearer(body.key, namespace === 'openai' ? 'codex' : 'grok');
          expect(resolved?.backendEngine).toBe('claude');
        }
      } finally { await app.close(); }
    });
    it(`${namespace}: legacy callers keep endpoint-default routing`, async () => {
      const { app } = await harness();
      try {
        const reply = await app.inject({ method: 'POST', url: `/admin/${namespace}/keys`, payload: { name: 'legacy' } });
        expect(reply.statusCode, reply.body).toBe(200);
        expect(reply.json().record.backend_engine).toBeNull();
      } finally { await app.close(); }
    });
    it(`${namespace}: rejects invalid or disabled assignments before creating a key`, async () => {
      const { app, db } = await harness();
      try {
        for (const backend of ['invalid', '', null, 3]) {
          const reply = await app.inject({ method: 'POST', url: `/admin/${namespace}/keys`, payload: { name: 'invalid', backend_engine: backend } });
          expect(reply.statusCode, reply.body).toBe(400);
        }
        const disabled = await app.inject({ method: 'POST', url: `/admin/${namespace}/keys`, payload: { name: 'disabled', backend_engine: 'grok' } });
        expect(disabled.statusCode, disabled.body).toBe(409);
        expect(disabled.json()).toMatchObject({ code: 'engine_disabled', engine: 'grok' });
        expect(db.tables.get(openaiApiKeys) ?? []).toHaveLength(0);
      } finally { await app.close(); }
    });
  }
});
