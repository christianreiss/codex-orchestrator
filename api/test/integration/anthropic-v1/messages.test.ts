import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import { ApiError } from '../../../src/http/errors.js';
import type {
  ClaudeMessage,
  ClaudeMessageResponse,
  RunnerClaudeAdapter,
} from '../../../src/services/adapters/runner-claude.js';
import type {
  ClaudeApiKeyContext,
  ClaudeKeyResolver,
} from '../../../src/services/claude-key-resolver.js';
import { extractAnthropicApiKey } from '../../../src/services/claude-key-resolver.js';
import type { ClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import type { ClaudeModelsService } from '../../../src/services/claude-models.js';
import { CLAUDE_SUPPORTED_MODELS } from '../../../src/services/claude-models.js';

/**
 * Integration tests for /anthropic/v1/*. The Phase 2.8 routes are registered
 * with injected service stubs so the suite stays DB-less.
 */

const VALID_KEY = 'sk-ant-' + 'a'.repeat(64);
const DISABLED_KEY = 'sk-ant-' + 'd'.repeat(64);
const AV = { 'anthropic-version': '2023-06-01' };

function stubKeyResolver(): ClaudeKeyResolver {
  const known: Record<string, ClaudeApiKeyContext | 'disabled'> = {
    [VALID_KEY]: {
      id: 1,
      name: 'test',
      keyPrefix: VALID_KEY.slice(0, 16) + '...',
      rateLimitRpm: 60,
      adminUserId: null,
    },
    [DISABLED_KEY]: 'disabled',
  };

  async function resolve(req: import('fastify').FastifyRequest): Promise<ClaudeApiKeyContext> {
    const raw = extractAnthropicApiKey(
      req.headers as Record<string, string | string[] | undefined>,
    );
    if (!raw) {
      throw new ApiError(
        'Missing API key. Include it in the Authorization header or x-api-key header.',
        { status: 401, code: 'invalid_api_key', type: 'authentication_error' },
      );
    }
    const found = known[raw];
    if (!found) {
      throw new ApiError('Invalid API key.', {
        status: 401,
        code: 'invalid_api_key',
        type: 'authentication_error',
      });
    }
    if (found === 'disabled') {
      throw new ApiError('API key is disabled.', {
        status: 401,
        code: 'invalid_api_key',
        type: 'authentication_error',
      });
    }
    return found;
  }

  return {
    resolve,
    preHandler: async (req) => {
      req.claudeApiKey = await resolve(req);
    },
  };
}

function stubKillSwitch(disabled = false): ClaudeKillSwitch {
  return {
    isDisabled: async () => disabled,
    ensureEnabled: async () => {
      if (disabled) {
        throw new ApiError('Claude API is currently disabled by administrator', {
          status: 503,
          code: 'api_disabled',
          type: 'api_error',
        });
      }
    },
    setDisabled: async () => undefined,
  };
}

function stubModels(): ClaudeModelsService {
  return {
    supportedModels: () => CLAUDE_SUPPORTED_MODELS,
    catalog: async () =>
      CLAUDE_SUPPORTED_MODELS.map((id) => ({ id, enabled: true, ownedBy: 'anthropic' as const })),
    disabledSet: async () => new Set(),
    setEnabled: async () => undefined,
    resolveRequestedModel: async (value: unknown) => {
      const v = typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : '';
      if (!v) return 'claude-sonnet-4-6';
      if ((CLAUDE_SUPPORTED_MODELS as readonly string[]).includes(v)) {
        return v as (typeof CLAUDE_SUPPORTED_MODELS)[number];
      }
      throw new ApiError(`Unsupported model "${v}".`, {
        status: 404,
        code: 'model_not_found',
        type: 'not_found_error',
        param: 'model',
      });
    },
    modelsResponse: async () => ({
      data: CLAUDE_SUPPORTED_MODELS.map(stubModelObject),
      has_more: false,
      first_id: CLAUDE_SUPPORTED_MODELS[0],
      last_id: CLAUDE_SUPPORTED_MODELS[CLAUDE_SUPPORTED_MODELS.length - 1]!,
      object: 'list' as const,
    }),
    modelResponse: async (value: unknown) => {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!(CLAUDE_SUPPORTED_MODELS as readonly string[]).includes(v)) {
        throw new ApiError('Model not found', {
          status: 404,
          code: 'model_not_found',
          type: 'not_found_error',
          param: 'model_id',
        });
      }
      return stubModelObject(v as (typeof CLAUDE_SUPPORTED_MODELS)[number]);
    },
  };
}

function stubModelObject(id: (typeof CLAUDE_SUPPORTED_MODELS)[number]) {
  return {
    type: 'model' as const,
    id,
    display_name: id,
    created_at: '2023-11-14T22:13:20.000Z',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    object: 'model' as const,
    created: 1700000000,
    owned_by: 'anthropic' as const,
  };
}

function stubAdapter(
  override?: Partial<ClaudeMessageResponse>,
): RunnerClaudeAdapter & {
  lastCall?: { messages: ClaudeMessage[]; model: string; params: unknown };
} {
  const spy: RunnerClaudeAdapter & {
    lastCall?: { messages: ClaudeMessage[]; model: string; params: unknown };
  } = {
    async messages(messages, model, params) {
      spy.lastCall = { messages, model, params };
      return {
        id: 'msg_test123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello back.' }],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        ...override,
      };
    },
  };
  return spy;
}

async function buildApp(opts: {
  adapter?: RunnerClaudeAdapter | null;
  apiDisabled?: boolean;
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);

  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => {
    req.clientIp = '127.0.0.1';
  });
  app.decorate('rateLimiter', {
    hit: async () => ({
      ok: true,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      count: 1,
    }),
  });

  await registerAnthropicCompatRoutes(
    app,
    {
      db: {} as never,
      env: {} as never,
      keyring: {} as never,
    },
    {
      adapter: opts.adapter ?? stubAdapter(),
      keyResolver: stubKeyResolver(),
      killSwitch: stubKillSwitch(opts.apiDisabled ?? false),
      models: stubModels(),
    },
  );

  return app;
}

describe('POST /anthropic/v1/messages', () => {
  let app: FastifyInstance;
  let adapter: ReturnType<typeof stubAdapter>;

  beforeAll(async () => {
    adapter = stubAdapter();
    app = await buildApp({ adapter });
  });

  afterAll(async () => {
    await app.close();
  });

  it('401s when no API key is supplied (Anthropic envelope)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error', code: 'invalid_api_key' },
    });
  });

  it('401s for a disabled key', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${DISABLED_KEY}`,
        ...AV,
      },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
  });

  it('400s with the Anthropic envelope when messages is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_messages' },
    });
  });

  it('400s with the Anthropic envelope when max_tokens is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_max_tokens' },
    });
  });

  it('400s when anthropic-version header is missing or unsupported', async () => {
    const app2 = await buildApp();
    for (const headers of [
      { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      {
        'content-type': 'application/json',
        authorization: `Bearer ${VALID_KEY}`,
        'anthropic-version': 'not-a-real-version',
      },
    ]) {
      const r = await app2.inject({
        method: 'POST',
        url: '/anthropic/v1/messages',
        headers,
        payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.payload)).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'invalid_anthropic_version' },
      });
    }
    await app2.close();
  });

  it('400s on consecutive same-role messages', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'user', content: 'hi again' },
        ],
      },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'invalid_message_role_sequence' },
    });
  });

  it('400s instead of leaking a runner 502 when role:system empties the conversation', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'system', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'empty_messages' },
    });
  });

  it('400s when tools are supplied (not yet supported by this backend)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'get_weather' },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'tools_not_supported' },
    });
  });

  it('returns a non-stream Claude message response', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-sonnet-4-6',
      },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({
      id: 'msg_test123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello back.' }],
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
  });

  it('sets Anthropic-shaped rate-limit and request-id headers', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['request-id']).toMatch(/^req_[0-9a-f]{32}$/);
    expect(r.headers['anthropic-ratelimit-requests-limit']).toBeDefined();
    expect(r.headers['anthropic-ratelimit-requests-remaining']).toBeDefined();
    expect(r.headers['anthropic-ratelimit-requests-reset']).toBeDefined();
  });

  it('also accepts the raw x-api-key header form', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': VALID_KEY, ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
  });

  it('hoists role:system messages into the system param before sending to the adapter', async () => {
    await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        max_tokens: 64,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
      },
    });
    expect(adapter.lastCall?.params).toMatchObject({ system: 'be brief' });
    expect(adapter.lastCall?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('streams Anthropic SSE events when stream:true', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const body = r.payload;
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: content_block_stop');
    expect(body).toContain('event: message_delta');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('"text":"Hello back."');
  });
});

describe('POST /anthropic/v1/messages/count_tokens', () => {
  it('returns a best-effort input_tokens estimate', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi there' }] },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(typeof body.input_tokens).toBe('number');
    expect(body.input_tokens).toBeGreaterThan(0);
    await app.close();
  });

  it('does not require max_tokens', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it('400s when messages is missing', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /anthropic/v1/models', () => {
  it('returns the model catalog in the Anthropic Models API shape', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/anthropic/v1/models',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBe(body.data[0].id);
    expect(body.last_id).toBe(body.data[body.data.length - 1].id);
    for (const m of body.data) {
      expect(m.type).toBe('model');
      expect(typeof m.id).toBe('string');
      expect(typeof m.display_name).toBe('string');
      expect(Number.isNaN(Date.parse(m.created_at))).toBe(false);
      // Legacy OpenAI-compat aliases are still served.
      expect(m.owned_by).toBe('anthropic');
      expect(m.object).toBe('model');
    }
    expect(body.object).toBe('list');
    await app.close();
  });

  it('retrieves a single model by id', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/anthropic/v1/models/claude-opus-4-8',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'model', id: 'claude-opus-4-8' });
    await app.close();
  });

  it('404s with not_found_error for an unknown model id', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/anthropic/v1/models/gpt-4o',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', code: 'model_not_found' },
    });
    await app.close();
  });
});

describe('POST /anthropic/v1/messages parameter conformance', () => {
  it('accepts `system` as an array of text blocks and flattens it', async () => {
    const adapter = stubAdapter();
    const app = await buildApp({ adapter });
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        model: 'claude-sonnet-4-6',
        max_tokens: 64,
        system: [
          { type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Answer in English.' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(r.statusCode).toBe(200);
    expect((adapter.lastCall?.params as { system?: string }).system).toBe(
      'You are terse.\n\nAnswer in English.',
    );
    await app.close();
  });

  it('still accepts `system` as a plain string', async () => {
    const adapter = stubAdapter();
    const app = await buildApp({ adapter });
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {
        max_tokens: 64,
        system: '  You are terse.  ',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(r.statusCode).toBe(200);
    expect((adapter.lastCall?.params as { system?: string }).system).toBe('You are terse.');
    await app.close();
  });

  it('400s on a present-but-invalid max_tokens', async () => {
    const app = await buildApp();
    for (const bad of [0, -1, 1.5, '100']) {
      const r = await app.inject({
        method: 'POST',
        url: '/anthropic/v1/messages',
        headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
        payload: { max_tokens: bad, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.payload)).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'invalid_max_tokens' },
      });
    }
    await app.close();
  });

  it('404s with not_found_error for an unsupported model', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { max_tokens: 64, model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(404);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error', code: 'model_not_found' },
    });
    await app.close();
  });
});

describe('POST /anthropic/v1/embeddings', () => {
  it('returns 501 with the documented Anthropic envelope', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/embeddings',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { input: 'hi', model: 'claude-sonnet-4-6' },
    });
    expect(r.statusCode).toBe(501);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'embeddings_unsupported' },
    });
    await app.close();
  });
});

describe('OPTIONS /anthropic/v1/*', () => {
  it('returns 204 with no body', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'OPTIONS',
      url: '/anthropic/v1/messages',
    });
    expect(r.statusCode).toBe(204);
    await app.close();
  });
});

describe('POST /anthropic/v1/completions', () => {
  it('builds a single-user-message call and shapes a completion body', async () => {
    const adapter = stubAdapter();
    const app = await buildApp({ adapter });
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/completions',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { prompt: 'tell me a joke', model: 'claude-sonnet-4-6' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body).toMatchObject({
      type: 'completion',
      completion: 'Hello back.',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });
    expect(adapter.lastCall?.messages).toEqual([{ role: 'user', content: 'tell me a joke' }]);
    await app.close();
  });

  it('400s with missing_prompt envelope when no prompt', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/completions',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_prompt' },
    });
    await app.close();
  });
});

describe('POST /anthropic/v1/responses', () => {
  it('returns an OpenAI-style responses body', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/responses',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { input: 'hi', model: 'claude-sonnet-4-6' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(typeof body.id).toBe('string');
    await app.close();
  });

  it('refuses stream:true with unsupported_stream', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/responses',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { input: 'hi', stream: true },
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'unsupported_stream' },
    });
    await app.close();
  });
});

describe('kill switch', () => {
  it('returns 503 with api_error envelope when claude_api_disabled is set', async () => {
    const app = await buildApp({ apiDisabled: true });
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}`, ...AV },
      payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'api_error', code: 'api_disabled' },
    });
    await app.close();
  });
});
