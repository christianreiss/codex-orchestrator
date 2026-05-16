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
        status: 400,
        code: 'model_not_found',
        type: 'invalid_request_error',
        param: 'model',
      });
    },
    modelsResponse: async () => ({
      data: CLAUDE_SUPPORTED_MODELS.map((id) => ({
        id,
        object: 'model' as const,
        created: 1700000000,
        owned_by: 'anthropic' as const,
      })),
      object: 'list' as const,
    }),
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
      headers: { 'content-type': 'application/json' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DISABLED_KEY}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'missing_messages' },
    });
  });

  it('returns a non-stream Claude message response', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], model: 'claude-sonnet-4-6' },
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

  it('also accepts the raw x-api-key header form', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': VALID_KEY },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
  });

  it('hoists role:system messages into the system param before sending to the adapter', async () => {
    await app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { authorization: `Bearer ${VALID_KEY}` },
      payload: {
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
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

describe('GET /anthropic/v1/models', () => {
  it('returns the model catalog', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'GET',
      url: '/anthropic/v1/models',
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(m.owned_by).toBe('anthropic');
      expect(m.object).toBe('model');
    }
    await app.close();
  });
});

describe('POST /anthropic/v1/embeddings', () => {
  it('returns 501 with the documented Anthropic envelope', async () => {
    const app = await buildApp();
    const r = await app.inject({
      method: 'POST',
      url: '/anthropic/v1/embeddings',
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
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
      headers: { authorization: `Bearer ${VALID_KEY}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'error',
      error: { type: 'api_error', code: 'api_disabled' },
    });
    await app.close();
  });
});
