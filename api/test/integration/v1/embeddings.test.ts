import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import type { RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { OpenaiApiKey } from '../../../src/db/schema.js';
import type { RunnerOpenAiAdapter } from '../../../src/services/adapters/runner-openai.js';
import { sha256 } from '../../../src/security/hash.js';

async function buildApp(): Promise<{ app: FastifyInstance; key: string }> {
  const app = Fastify({ logger: false });
  const key = 'sk-cdx-' + 'd'.repeat(64);
  const record: OpenaiApiKey = {
    id: 4,
    name: 'embeddings-test',
    keyPrefix: key.slice(0, 16) + '...',
    keyHash: sha256(key),
    keyEnc: null,
    adminUserId: null,
    rateLimitRpm: 60,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    engine: 'codex',
  };

  app.decorate('rateLimiter', {
    hit: async () => ({ ok: true, count: 1, resetAt: new Date().toISOString() }),
  } satisfies RateLimiter);
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

describe('/v1/embeddings', () => {
  let app: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    const h = await buildApp();
    app = h.app;
    key = h.key;
  });

  it('returns 501 with feature_not_supported (runner has no embeddings)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'hello', model: 'gpt-5.4' },
    });
    expect(r.statusCode).toBe(501);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { code: 'feature_not_supported', type: 'not_implemented' },
    });
  });
});
