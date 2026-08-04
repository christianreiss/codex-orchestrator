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

async function buildApp(): Promise<{ app: FastifyInstance; key: string }> {
  const app = Fastify({ logger: false });
  const key = 'sk-cdx-' + 'b'.repeat(64);
  const keyHash = sha256(key);
  const record: OpenaiApiKey = {
    id: 2,
    name: 'completions-test',
    keyPrefix: key.slice(0, 16) + '...',
    keyHash,
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

  const adapter = {
    completions: async (prompt: string, model: string) => ({
      id: 'cmpl-fake',
      object: 'text_completion' as const,
      created: 1700000000,
      model,
      choices: [
        {
          text: `echo: ${prompt}`,
          index: 0,
          logprobs: null,
          finish_reason: 'stop' as const,
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  } as unknown as RunnerOpenAiAdapter;

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
      adapter,
    },
  );
  await app.ready();
  return { app, key };
}

describe('/v1/completions', () => {
  let app: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    const h = await buildApp();
    app = h.app;
    key = h.key;
  });

  it('rejects an empty prompt', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { prompt: '   ' },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { param: 'prompt', type: 'invalid_request_error' },
    });
  });

  it('returns a text completion on a valid request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { prompt: 'hello' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('text_completion');
    expect(body.choices[0].text).toBe('echo: hello');
  });
});
