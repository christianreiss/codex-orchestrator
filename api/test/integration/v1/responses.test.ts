import { describe, it, expect, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import type { RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { OpenaiApiKey } from '../../../src/db/schema.js';
import type {
  RunnerOpenAiAdapter,
  ChatCompletionResult,
  ResponsesResult,
} from '../../../src/services/adapters/runner-openai.js';
import { responseFromChatCompletion } from '../../../src/services/adapters/runner-openai.js';
import { sha256 } from '../../../src/security/hash.js';

async function buildApp(): Promise<{ app: FastifyInstance; key: string }> {
  const app = Fastify({ logger: false });
  const key = 'sk-cdx-' + 'c'.repeat(64);
  const record: OpenaiApiKey = {
    id: 3,
    name: 'responses-test',
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

  const adapter = {
    chatCompletions: async (
      _msgs: unknown,
      model: string,
    ): Promise<ChatCompletionResult> => ({
      id: 'chatcmpl-resp',
      object: 'chat.completion',
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    responses: async (msgs: unknown, model: string): Promise<ResponsesResult> => {
      const completion = await (adapter as RunnerOpenAiAdapter).chatCompletions(
        msgs as never,
        model,
      );
      return responseFromChatCompletion(completion);
    },
  } as unknown as RunnerOpenAiAdapter;

  const rateLimiter: RateLimiter = {
    hit: async () => ({ ok: true, count: 1, resetAt: new Date().toISOString() }),
  };

  app.decorate('rateLimiter', rateLimiter);
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

describe('/v1/responses', () => {
  let app: FastifyInstance;
  let key: string;

  beforeAll(async () => {
    const h = await buildApp();
    app = h.app;
    key = h.key;
  });

  it('returns a response object on string input', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'what is 2+2?' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output[0].content[0].text).toBe('answer');
  });

  it('carries the response fields openai-python reads without AttributeError', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'what is 2+2?' },
    });
    const body = JSON.parse(r.payload);
    // Required-without-default fields on the typed Response object.
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe('auto');
    expect(body.text).toEqual({ format: { type: 'text' } });
    expect(body.usage.input_tokens_details).toEqual({ cached_tokens: 0 });
    // Nullable-default fields.
    expect(body.error).toBeNull();
    expect(body.incomplete_details).toBeNull();
    expect(body.metadata).toEqual({});
  });

  it('rejects an empty input', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { param: 'input', type: 'invalid_request_error' },
    });
  });

  it('refuses streaming for /v1/responses', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'hi', stream: true },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { code: 'unsupported_stream' },
    });
  });
});
