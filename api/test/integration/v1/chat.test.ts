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
  CompletionResult,
  ResponsesResult,
  OpenAiMessage,
  OpenAiGenerationParams,
} from '../../../src/services/adapters/runner-openai.js';
import { sha256 } from '../../../src/security/hash.js';

/**
 * Integration harness for `/v1/*`. Stubs the rate limiter, key service, and
 * runner adapter so the tests don't need MySQL or a live runner. Exercises the
 * full Fastify request lifecycle (CORS, envelope, error handler).
 */

interface HarnessOverrides {
  killSwitchDisabled?: boolean;
  adapter?: RunnerOpenAiAdapter | null;
  keyOverrides?: Partial<OpenaiApiKey>;
  rateLimitOk?: boolean;
}

async function buildHarness(opts: HarnessOverrides = {}): Promise<{
  app: FastifyInstance;
  validKey: string;
  keyHash: string;
}> {
  const app = Fastify({ logger: false });

  const validKey = 'sk-cdx-' + 'a'.repeat(64);
  const keyHash = sha256(validKey);
  const keyRecord: OpenaiApiKey = {
    id: 1,
    name: 'test',
    keyPrefix: validKey.slice(0, 16) + '...',
    keyHash,
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
    ...opts.keyOverrides,
  };

  const keysStub = {
    findActiveByBearer: async (token: string) => (token === validKey ? keyRecord : null),
    touch: async () => {},
  } as unknown as OpenAiKeyService;

  const rateLimiter: RateLimiter = {
    hit: async () => ({
      ok: opts.rateLimitOk ?? true,
      count: 1,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    }),
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
    {
      db: {} as never,
      env: {} as never,
      keyring: {} as never,
    },
    {
      keys: keysStub,
      killSwitch: {
        isDisabled: async () => opts.killSwitchDisabled === true,
        throwIfDisabled: async () => {
          if (opts.killSwitchDisabled === true) {
            // Mirror the production thrown ApiError so the envelope shapes it.
            throw new (await import('../../../src/http/errors.js')).ApiError(
              'OpenAI API disabled by administrator',
              { status: 503, code: 'api_disabled', type: 'api_error' },
            );
          }
        },
      },
      adapter: opts.adapter,
    },
  );

  await app.ready();
  return { app, validKey, keyHash };
}

function fakeAdapter(): RunnerOpenAiAdapter {
  return {
    chatCompletions: async (
      _msgs: OpenAiMessage[],
      model: string,
      _params: OpenAiGenerationParams,
    ): Promise<ChatCompletionResult> => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    responses: async (
      msgs: OpenAiMessage[],
      model: string,
      params: OpenAiGenerationParams,
    ): Promise<ResponsesResult> => {
      // The real adapter delegates to chatCompletions and reshapes; keep that contract.
      const adapter = fakeAdapter();
      const completion = await adapter.chatCompletions(msgs, model, params);
      const { responseFromChatCompletion } = await import(
        '../../../src/services/adapters/runner-openai.js'
      );
      return responseFromChatCompletion(completion);
    },
    completions: async (
      prompt: string,
      model: string,
    ): Promise<CompletionResult> => ({
      id: 'cmpl-test',
      object: 'text_completion',
      created: 1700000000,
      model,
      choices: [
        {
          text: `echo: ${prompt}`,
          index: 0,
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }),
  } as unknown as RunnerOpenAiAdapter;
}

describe('/v1/chat/completions', () => {
  let app: FastifyInstance;
  let validKey: string;

  beforeAll(async () => {
    const h = await buildHarness({ adapter: fakeAdapter() });
    app = h.app;
    validKey = h.validKey;
  });

  it('rejects requests without a bearer token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: {
        message: 'Incorrect API key provided',
        // Upstream OpenAI 401 uses type invalid_request_error + invalid_api_key,
        // NOT authentication_error (that's the Anthropic wire shape).
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
  });

  it('rejects requests with an unknown bearer token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-cdx-nope' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns OpenAI-shape body on a valid request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: { messages: [{ role: 'user', content: 'ping' }] },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('pong');
    expect(body.model).toBe('gpt-5.6-terra');
  });

  it('returns 400 with param=messages when missing messages', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'invalid_request_error', param: 'messages' },
    });
  });

  it('returns 404 model_not_found for an unsupported model', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: { model: 'not-a-real-model', messages: [{ role: 'user', content: 'x' }] },
    });
    // Upstream OpenAI: 404 with code model_not_found, type stays
    // invalid_request_error (NOT the Anthropic not_found_error).
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'invalid_request_error', code: 'model_not_found' },
    });
  });

  it('upgrades a legacy model alias and succeeds', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: { model: 'gpt-5.3-codex', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).model).toBe('gpt-5.6-terra');
  });

  it('returns 503 with code=api_disabled when kill switch is on', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({
      adapter: fakeAdapter(),
      killSwitchDisabled: true,
    });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(503);
    // The internal `api_error` type is remapped to OpenAI's `server_error`
    // (>=500) by the envelope; the code is preserved.
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'server_error', code: 'api_disabled' },
    });
    await app2.close();
  });

  it('returns 429 with code=rate_limit_exceeded when rate limited', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({
      adapter: fakeAdapter(),
      rateLimitOk: false,
    });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
    expect(r.headers['retry-after']).toBeDefined();
    await app2.close();
  });

  it('returns 503 with code=backend_unavailable when adapter is null', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: null });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'server_error', code: 'backend_unavailable' },
    });
    await app2.close();
  });

  it('streams SSE when stream:true', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    const body = r.payload;
    expect(body).toContain('data: ');
    expect(body).toContain('chat.completion.chunk');
    expect(body).toContain('data: [DONE]');
  });

  it('emits a final usage chunk when stream_options.include_usage is set', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: {
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(r.statusCode).toBe(200);
    const chunks = r.payload
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice('data: '.length)));
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk).toBeDefined();
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('omits the usage chunk without include_usage', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${validKey}` },
      payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const chunks = r.payload
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice('data: '.length)));
    expect(chunks.some((c) => c.usage)).toBe(false);
  });

  it('maps max_completion_tokens onto the runner output cap', async () => {
    let seen: OpenAiGenerationParams | undefined;
    const spy = {
      chatCompletions: async (
        _m: OpenAiMessage[],
        model: string,
        params: OpenAiGenerationParams,
      ): Promise<ChatCompletionResult> => {
        seen = params;
        return {
          id: 'chatcmpl-x',
          object: 'chat.completion',
          created: 1700000000,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    } as unknown as RunnerOpenAiAdapter;
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: spy });
    await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 42 },
    });
    expect(seen?.max_tokens).toBe(42);
    await app2.close();
  });

  it('400s on an out-of-range temperature', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: fakeAdapter() });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], temperature: 5 },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'invalid_request_error', param: 'temperature' },
    });
    await app2.close();
  });

  it('accepts temperature 0 (a valid upstream value)', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: fakeAdapter() });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], temperature: 0 },
    });
    expect(r.statusCode).toBe(200);
    await app2.close();
  });

  it('400s when tool_choice forces a call (required)', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: fakeAdapter() });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: {
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
        tool_choice: 'required',
      },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { type: 'invalid_request_error', code: 'tools_not_supported', param: 'tool_choice' },
    });
    await app2.close();
  });

  it('400s when tool_choice names a specific function', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: fakeAdapter() });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: {
        messages: [{ role: 'user', content: 'weather?' }],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      error: { code: 'tools_not_supported' },
    });
    await app2.close();
  });

  it('still returns text for tool_choice:auto with tools present (wire-legal)', async () => {
    const { app: app2, validKey: vk2 } = await buildHarness({ adapter: fakeAdapter() });
    const r = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${vk2}` },
      payload: {
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
        tool_choice: 'auto',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).object).toBe('chat.completion');
    await app2.close();
  });

  it('returns 204 for OPTIONS preflight', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions' });
    expect(r.statusCode).toBe(204);
  });
});
