import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGrokCompatRoutes } from '../../../src/routes/grok-v1/index.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { RunnerOpenAiAdapter } from '../../../src/services/adapters/runner-openai.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { ApiError } from '../../../src/http/errors.js';

async function harness(opts: { disabled?: boolean; usage?: boolean; finish?: string; cache?: number; reasoning?: number } = {}) {
  const app = Fastify();
  await app.register(envelopePlugin);
  const snapshot = vi.fn(async () => ({ grok_auth: { selected: { auth_mode: 'external', key: 'access-only' } } }));
  const dispatched = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
    status: 'ok', output: 'Grok answer', finish_reason: opts.finish ?? 'stop', cache_read_input_tokens: opts.cache, reasoning_tokens: opts.reasoning, usage_known: opts.usage === true,
    input_tokens: 70, output_tokens: 5,
  })));
  vi.stubGlobal('fetch', dispatched);
  const keys = {
    findActiveByBearer: vi.fn(async (bearer: string, engine: string) => bearer === 'grok-key' && engine === 'grok' ? { id: 1 } : null),
    touch: vi.fn(),
  } as unknown as OpenAiKeyService;
  const adapter = new RunnerOpenAiAdapter({ engine: 'grok', execUrl: 'http://runner/exec', sharedSecret: 'test', timeoutSeconds: 600, authSnapshot: snapshot });
  await registerGrokCompatRoutes(app, { db: {} as never, keyring: {} as never, env: {} as never }, {
    keys, adapter,
    killSwitch: {
      isDisabled: async () => opts.disabled === true,
      throwIfDisabled: async () => { if (opts.disabled) throw new ApiError('Grok API disabled', { status: 503, code: 'api_disabled' }); },
    },
    models: {
      resolveRequestedModel: async value => {
        if (value && value !== 'grok-4.6') throw new ApiError('Unknown Grok model', { status: 404, code: 'model_not_found', type: 'invalid_request_error' });
        return 'grok-4.6';
      },
      modelsResponse: async () => ({ object: 'list', data: [{ id: 'grok-4.6', object: 'model', owned_by: 'xai' }] }),
    },
  });
  await app.ready();
  return { app, dispatched, snapshot, keys };
}

describe('Grok subscription gateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('isolates the prefix, engine key and access-only dispatch while forwarding system instructions', async () => {
    const { app, dispatched } = await harness({ usage: true });
    try {
      const reply = await app.inject({ method: 'POST', url: '/grok/v1/chat/completions', headers: { authorization: 'Bearer grok-key' }, payload: {
        messages: [{ role: 'system', content: 'Only answer questions' }, { role: 'user', content: 'hi' }],
      } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ model: 'grok-4.6', choices: [{ finish_reason: 'stop', message: { content: 'Grok answer' } }], usage: { prompt_tokens: 70, completion_tokens: 5, total_tokens: 75 } });
      const body = JSON.parse(dispatched.mock.calls[0]?.[1]?.body as string);
      expect(body).toMatchObject({ engine: 'grok', model: 'grok-4.6', system: 'Only answer questions', timeout_seconds: 600 });
      expect(body.prompt).not.toContain('system:');
      expect(JSON.stringify(body.auth_json)).not.toContain('refresh_token');
      expect((await app.inject('/v1/models')).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it.each(['max_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stream', 'tools'])('rejects %s before requesting auth or executing', async control => {
    const { app, snapshot, dispatched } = await harness();
    try {
      const values: Record<string, unknown> = { max_tokens: 10, temperature: 0, top_p: 0.5, top_k: 3, stop: ['END'], stream: true, tools: [{ type: 'function', function: { name: 'call' } }] };
      const reply = await app.inject({ method: 'POST', url: '/grok/v1/chat/completions', headers: { authorization: 'Bearer grok-key' }, payload: { messages: [{ role: 'user', content: 'hi' }], [control]: values[control] } });
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('unsupported_generation_control');
      expect(snapshot).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('reports unavailable usage as null rather than zero', async () => {
    const { app } = await harness();
    try {
      const reply = await app.inject({ method: 'POST', url: '/grok/v1/responses', headers: { authorization: 'Bearer grok-key' }, payload: { input: 'hi' } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().usage).toBeNull();
    } finally { await app.close(); }
  });

  it('preserves native cache/reasoning accounting and incomplete Responses status', async () => {
    const { app } = await harness({ usage: true, cache: 40, reasoning: 3, finish: 'length' });
    try {
      const reply = await app.inject({ method: 'POST', url: '/grok/v1/responses', headers: { authorization: 'Bearer grok-key' }, payload: { input: 'hi' } });
      expect(reply.json()).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 70, input_tokens_details: { cached_tokens: 40 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 75 } });
    } finally { await app.close(); }
  });

  it('forwards text-array instructions and rejects images before requesting auth', async () => {
    const { app, dispatched, snapshot } = await harness();
    try {
      const headers = { authorization: 'Bearer grok-key' };
      expect((await app.inject({ method: 'POST', url: '/grok/v1/chat/completions', headers, payload: { messages: [{ role: 'system', content: [{ type: 'text', text: 'Only questions' }] }, { role: 'user', content: 'hi' }] } })).statusCode).toBe(200);
      expect(JSON.parse(dispatched.mock.calls[0]?.[1]?.body as string).system).toBe('Only questions');
      snapshot.mockClear(); dispatched.mockClear();
      expect((await app.inject({ method: 'POST', url: '/grok/v1/chat/completions', headers, payload: { messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }, { role: 'user', content: 'hi' }] } })).statusCode).toBe(400);
      expect(snapshot).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('enforces its switch and Grok-scoped keys with OpenAI errors', async () => {
    const { app } = await harness();
    try {
      const reply = await app.inject({ url: '/grok/v1/models', headers: { authorization: 'Bearer codex-key' } });
      expect(reply.statusCode).toBe(401);
      expect(reply.json()).toMatchObject({ error: { code: 'invalid_api_key', type: 'invalid_request_error' } });
      expect((await app.inject({ url: '/grok/v1/models', headers: { authorization: 'Bearer grok-key' } })).json()).toMatchObject({ object: 'list', data: [{ id: 'grok-4.6' }] });
    } finally { await app.close(); }
    const disabled = await harness({ disabled: true });
    try { expect((await disabled.app.inject({ url: '/grok/v1/models', headers: { authorization: 'Bearer grok-key' } })).statusCode).toBe(503); }
    finally { await disabled.app.close(); }
  });
});
