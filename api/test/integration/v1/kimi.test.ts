import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKimiCompatRoutes } from '../../../src/routes/kimi-v1/index.js';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { RunnerOpenAiAdapter } from '../../../src/services/adapters/runner-openai.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { ApiError } from '../../../src/http/errors.js';

async function harness(opts: { disabled?: boolean; usage?: boolean; finish?: string; cache?: number; reasoning?: number } = {}) {
  const app = Fastify();
  await app.register(envelopePlugin);
  const snapshot = vi.fn(async () => ({ kimi_code: { access_token: 'access-only', refresh_token: '', expires_at: 2000000000 }, device_id: 'a'.repeat(32) }));
  const dispatched = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
    status: 'ok', output: 'Kimi answer', finish_reason: opts.finish ?? 'stop', cache_read_input_tokens: opts.cache, reasoning_tokens: opts.reasoning, usage_known: opts.usage === true,
    input_tokens: 70, output_tokens: 5,
  })));
  vi.stubGlobal('fetch', dispatched);
  const keys = {
    findActiveByBearer: vi.fn(async (bearer: string, engine: string) => bearer === 'kimi-key' && engine === 'kimi' ? { id: 1 } : null),
    touch: vi.fn(),
  } as unknown as OpenAiKeyService;
  const adapter = new RunnerOpenAiAdapter({ engine: 'kimi', execUrl: 'http://runner/exec', sharedSecret: 'test', timeoutSeconds: 600, authSnapshot: snapshot });
  await registerKimiCompatRoutes(app, { db: {} as never, keyring: {} as never, env: {} as never }, {
    keys, adapter,
    killSwitch: {
      isDisabled: async () => opts.disabled === true,
      throwIfDisabled: async () => { if (opts.disabled) throw new ApiError('Kimi API disabled', { status: 503, code: 'api_disabled' }); },
    },
    models: {
      resolveRequestedModel: async value => {
        if (value && value !== 'kimi-for-coding') throw new ApiError('Unknown Kimi model', { status: 404, code: 'model_not_found', type: 'invalid_request_error' });
        return 'kimi-for-coding';
      },
      modelsResponse: async () => ({ object: 'list', data: [{ id: 'kimi-for-coding', object: 'model', owned_by: 'moonshotai' }] }),
    },
  });
  await app.ready();
  return { app, dispatched, snapshot, keys };
}

describe('Kimi subscription gateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('isolates the prefix, engine key and access-only dispatch while forwarding system instructions', async () => {
    const { app, dispatched } = await harness({ usage: true });
    try {
      const reply = await app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers: { authorization: 'Bearer kimi-key' }, payload: {
        messages: [{ role: 'system', content: 'Only answer questions' }, { role: 'user', content: 'hi' }],
      } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toMatchObject({ model: 'kimi-for-coding', choices: [{ finish_reason: null, message: { content: 'Kimi answer' } }], usage: null });
      const body = JSON.parse(dispatched.mock.calls[0]?.[1]?.body as string);
      expect(body).toMatchObject({ engine: 'kimi', model: 'kimi-for-coding', system: 'Only answer questions', timeout_seconds: 600 });
      expect(body.prompt).not.toContain('system:');
      expect(body.auth_json.kimi_code.refresh_token).toBe('');
      expect((await app.inject('/v1/models')).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it.each(['max_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stream', 'tools'])('rejects %s before requesting auth or executing', async control => {
    const { app, snapshot, dispatched } = await harness();
    try {
      const values: Record<string, unknown> = { max_tokens: 10, temperature: 0, top_p: 0.5, top_k: 3, stop: ['END'], stream: true, tools: [{ type: 'function', function: { name: 'call' } }] };
      const reply = await app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers: { authorization: 'Bearer kimi-key' }, payload: { messages: [{ role: 'user', content: 'hi' }], [control]: values[control] } });
      expect(reply.statusCode).toBe(400);
      expect(reply.json().error.code).toBe('unsupported_generation_control');
      expect(snapshot).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('reports unavailable usage as null rather than zero', async () => {
    const { app } = await harness();
    try {
      const reply = await app.inject({ method: 'POST', url: '/kimi/v1/responses', headers: { authorization: 'Bearer kimi-key' }, payload: { input: 'hi' } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().usage).toBeNull();
    } finally { await app.close(); }
  });

  it('does not invent usage or stop reasons from runner metadata', async () => {
    const { app } = await harness({ usage: true, cache: 40, reasoning: 3, finish: 'length' });
    try {
      const headers = { authorization: 'Bearer kimi-key' };
      const reply = await app.inject({ method: 'POST', url: '/kimi/v1/responses', headers, payload: { input: 'hi' } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().usage).toBeNull();
      const chat = await app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers, payload: { messages: [{ role: 'user', content: 'hi' }] } });
      expect(chat.json().choices[0].finish_reason).toBeNull();
    } finally { await app.close(); }
  });

  it.each([
    { route: 'completions', payload: { prompt: 'a'.repeat(100001) } },
    { route: 'chat/completions', payload: { messages: [{ role: 'user', content: '😀'.repeat(25000) }] } },
    { route: 'responses', payload: { input: 'short', instructions: 'ü'.repeat(50000) } },
  ])('bounds the rendered UTF-8 prompt before auth on $route', async ({ route, payload }) => {
    const { app, snapshot, dispatched } = await harness();
    try {
      const reply = await app.inject({ method: 'POST', url: `/kimi/v1/${route}`, headers: { authorization: 'Bearer kimi-key' }, payload });
      expect(reply.statusCode).toBe(413);
      expect(reply.json()).toMatchObject({ error: { code: 'prompt_too_large', type: 'invalid_request_error', message: expect.stringContaining('100000 UTF-8 bytes') } });
      expect(snapshot).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('accepts exactly 100000 UTF-8 bytes for legacy completions', async () => {
    const { app, dispatched } = await harness();
    try {
      const reply = await app.inject({ method: 'POST', url: '/kimi/v1/completions', headers: { authorization: 'Bearer kimi-key' }, payload: { prompt: '😀'.repeat(25000) } });
      expect(reply.statusCode).toBe(200);
      expect(dispatched).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it('forwards text-array instructions and rejects images before requesting auth', async () => {
    const { app, dispatched, snapshot } = await harness();
    try {
      const headers = { authorization: 'Bearer kimi-key' };
      expect((await app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers, payload: { messages: [{ role: 'system', content: [{ type: 'text', text: 'Only questions' }] }, { role: 'user', content: 'hi' }] } })).statusCode).toBe(200);
      expect(JSON.parse(dispatched.mock.calls[0]?.[1]?.body as string).system).toBe('Only questions');
      snapshot.mockClear(); dispatched.mockClear();
      expect((await app.inject({ method: 'POST', url: '/kimi/v1/chat/completions', headers, payload: { messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }, { role: 'user', content: 'hi' }] } })).statusCode).toBe(400);
      expect(snapshot).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('enforces its switch and Kimi-scoped keys with OpenAI errors', async () => {
    const { app } = await harness();
    try {
      const reply = await app.inject({ url: '/kimi/v1/models', headers: { authorization: 'Bearer codex-key' } });
      expect(reply.statusCode).toBe(401);
      expect(reply.json()).toMatchObject({ error: { code: 'invalid_api_key', type: 'invalid_request_error' } });
      expect((await app.inject({ url: '/kimi/v1/models', headers: { authorization: 'Bearer kimi-key' } })).json()).toMatchObject({ object: 'list', data: [{ id: 'kimi-for-coding' }] });
    } finally { await app.close(); }
    const disabled = await harness({ disabled: true });
    try { expect((await disabled.app.inject({ url: '/kimi/v1/models', headers: { authorization: 'Bearer kimi-key' } })).statusCode).toBe(503); }
    finally { await disabled.app.close(); }
  });
});
