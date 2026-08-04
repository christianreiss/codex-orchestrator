import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { OpenaiApiKey } from '../../../src/db/schema.js';
import type { RunnerOpenAiAdapter } from '../../../src/services/adapters/runner-openai.js';
import { sha256 } from '../../../src/security/hash.js';
import { OPENAI_MODELS } from '../../../src/services/openai-models.js';

async function buildApp(): Promise<{ app: FastifyInstance; key: string }> {
  const app = Fastify({ logger: false });
  const key = 'sk-cdx-' + 'e'.repeat(64);
  const record: OpenaiApiKey = {
    id: 5,
    name: 'models-test',
    keyPrefix: key.slice(0, 16) + '...',
    keyHash: sha256(key),
    keyEnc: null,
    adminUserId: null,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    engine: 'codex',
  };

  app.decorateRequest('clientIp', '127.0.0.1');
  app.addHook('onRequest', async (req) => {
    (req as { clientIp: string }).clientIp = '127.0.0.1';
  });

  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  await registerOpenAiCompatRoutes(
    app,
    { db: {} as never, env: {} as never, keyring: {} as never },
    {
      keys: {
        findActiveByBearer: async (token: string) => (token === key ? record : null),
        touch: async () => {},
      } as unknown as OpenAiKeyService,
      killSwitch: {
        isDisabled: async () => false,
        throwIfDisabled: async () => {},
      },
      adapter: {} as unknown as RunnerOpenAiAdapter,
    },
  );
  await app.ready();
  return { app, key };
}

describe('/v1/models', () => {
  let app: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    const h = await buildApp();
    app = h.app;
    key = h.key;
  });

  it('returns the OpenAI-shape model list', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(OPENAI_MODELS.length);
    for (const id of OPENAI_MODELS) {
      expect(body.data.find((m: { id: string }) => m.id === id)).toBeDefined();
    }
    for (const m of body.data) {
      expect(m).toMatchObject({ object: 'model', owned_by: 'codex-orchestrator' });
    }
  });

  it('requires authentication', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(r.statusCode).toBe(401);
  });

  it('retrieves a single model (GET /v1/models/{id})', async () => {
    const id = OPENAI_MODELS[0]!;
    const r = await app.inject({
      method: 'GET',
      url: `/v1/models/${id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({ id, object: 'model', owned_by: 'codex-orchestrator' });
    expect(typeof body.created).toBe('number');
  });

  it('returns 404 model_not_found for an unknown single-model id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/models/not-a-real-model',
      headers: { authorization: `Bearer ${key}` },
    });
    // Upstream: 404 + code model_not_found, type stays invalid_request_error.
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'invalid_request_error', code: 'model_not_found' },
    });
  });

  it('single-model retrieve requires authentication', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/models/${OPENAI_MODELS[0]}` });
    expect(r.statusCode).toBe(401);
  });

  it('serves a stable `created` timestamp (not Date.now())', async () => {
    const first = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } })).payload,
    );
    const second = JSON.parse(
      (await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } })).payload,
    );
    expect(first.data[0].created).toBe(second.data[0].created);
  });
});
