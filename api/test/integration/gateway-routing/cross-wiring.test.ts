import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { ApiError } from '../../../src/http/errors.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import { registerGrokCompatRoutes } from '../../../src/routes/grok-v1/index.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import {
  createGatewayBackends,
  type GatewayBackendModels,
  type GatewayWiring,
} from '../../../src/services/gateway-backends.js';
import { OPENAI_DEFAULT_MODEL } from '../../../src/services/openai-models.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { ClaudeKeyResolver } from '../../../src/services/claude-key-resolver.js';
import type { ClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import type { Engine } from '../../../src/util/engine.js';

/**
 * Every exposed API surface against every backend engine: the surface keeps
 * its wire shape and key namespace, the backend decides the runner `engine`,
 * the credential snapshot, the model catalog and what the CLI can honour.
 */

const BACKENDS: Engine[] = ['codex', 'claude', 'grok'];
const SNAPSHOTS: Record<Engine, Record<string, unknown>> = {
  codex: { tokens: { access_token: 'codex-access' } },
  claude: { claudeAiOauth: { accessToken: 'claude-access' } },
  grok: { grok_auth: { selected: { key: 'grok-access' } } },
};
const RUNNER_RESULTS: Record<Engine, Record<string, unknown>> = {
  codex: { status: 'ok', output: 'from codex' },
  claude: { status: 'ok', output: 'from claude', input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 },
  grok: {
    status: 'ok', output: 'from grok', finish_reason: 'stop', native_stop_reason: 'end_turn', usage_known: true,
    input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0,
  },
};
const CATALOGS: Record<'claude' | 'grok', string[]> = {
  claude: ['claude-sonnet-5', 'claude-opus-5'],
  grok: ['grok-4.7', 'grok-4.6'],
};
const KEYS: Record<string, string> = { codex: 'sk-cdx-test', claude: 'sk-ant-test', grok: 'sk-cgx-test' };

function stubModels(engine: 'claude' | 'grok'): GatewayBackendModels {
  const ids = CATALOGS[engine];
  const owner = engine === 'claude' ? 'anthropic' : 'xai';
  const info = (id: string) => ({ id, display_name: id, created: 1_767_225_600, owned_by: owner });
  return {
    async resolve(value) {
      const id = typeof value === 'string' ? value.trim() : '';
      if (id === '') return ids[0]!;
      if (ids.includes(id)) return id;
      throw new ApiError(`Unsupported model "${id}"`, { status: 404, code: 'model_not_found', param: 'model' });
    },
    catalog: async () => ids.map(info),
    info,
  };
}

async function harness(backend: Engine) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => { req.clientIp = '127.0.0.1'; });

  const runner = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { engine: Engine };
    return new Response(JSON.stringify(RUNNER_RESULTS[body.engine]));
  });
  vi.stubGlobal('fetch', runner);

  const execs: Array<{ engine: Engine; snapshot: unknown }> = [];
  const ctx = {
    db: {} as never,
    keyring: {} as never,
    env: { AUTH_RUNNER_URL: 'http://runner/verify', AUTH_RUNNER_SHARED_SECRET: 'secret', AUTH_RUNNER_EXEC_TIMEOUT: 600 } as never,
  };
  const overrides = Object.fromEntries(BACKENDS.map((engine) => [engine, {
    authSnapshot: async () => SNAPSHOTS[engine],
    onExecSuccess: (snapshot: unknown) => { execs.push({ engine, snapshot }); },
    ...(engine === 'codex' ? {} : { models: stubModels(engine) }),
  }]));
  const gateway: GatewayWiring = {
    backends: createGatewayBackends(ctx, undefined, overrides),
    routing: { backendFor: async () => backend },
  };

  const keys = {
    findActiveByBearer: async (token: string, engine: string) => (KEYS[engine] === token ? { id: 1, engine } : null),
    touch: async () => undefined,
  } as unknown as OpenAiKeyService;
  const killSwitch = { isDisabled: async () => false, throwIfDisabled: async () => undefined };
  const keyResolver: ClaudeKeyResolver = {
    resolve: async () => ({ id: 1, name: 'test', keyPrefix: 'sk-ant-', adminUserId: null }),
    preHandler: async (req) => {
      if (req.headers['x-api-key'] !== KEYS.claude) {
        throw new ApiError('Invalid API key.', { status: 401, code: 'invalid_api_key', type: 'authentication_error' });
      }
      req.claudeApiKey = { id: 1, name: 'test', keyPrefix: 'sk-ant-', adminUserId: null };
    },
  };
  const claudeKillSwitch: ClaudeKillSwitch = { isDisabled: async () => false, ensureEnabled: async () => undefined, setDisabled: async () => undefined };

  await registerOpenAiCompatRoutes(app, ctx, { gateway, keys, killSwitch });
  await registerGrokCompatRoutes(app, ctx, { gateway, keys, killSwitch });
  await registerAnthropicCompatRoutes(app, ctx, { gateway, keyResolver, killSwitch: claudeKillSwitch });
  await app.ready();
  const dispatched = () => JSON.parse(String(runner.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
  return { app, runner, dispatched, execs };
}

const DEFAULT_MODEL: Record<Engine, string> = { codex: OPENAI_DEFAULT_MODEL, claude: 'claude-sonnet-5', grok: 'grok-4.7' };

async function close(app: FastifyInstance) {
  await app.close();
}

describe('any-to-any gateway routing', () => {
  afterEach(() => vi.unstubAllGlobals());

  const OPENAI_SURFACES = [
    { surface: 'openai', base: '/v1', key: KEYS.codex, identity: 'codex' as Engine, model: OPENAI_DEFAULT_MODEL },
    { surface: 'grok', base: '/grok/v1', key: KEYS.grok, identity: 'grok' as Engine, model: 'grok-4.6' },
  ];

  for (const s of OPENAI_SURFACES) {
    for (const backend of BACKENDS) {
      it(`${s.base} served by ${backend}`, async () => {
        const { app, dispatched, execs } = await harness(backend);
        try {
          const reply = await app.inject({
            method: 'POST',
            url: `${s.base}/chat/completions`,
            headers: { authorization: `Bearer ${s.key}` },
            payload: { model: s.model, messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'hi' }] },
          });
          expect(reply.statusCode).toBe(200);
          const body = reply.json();
          expect(body).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: `from ${backend}` } }] });
          expect(body.model).toBe(backend === s.identity ? s.model : DEFAULT_MODEL[backend]);

          const sent = dispatched();
          expect(sent.engine).toBe(backend);
          expect(sent.auth_json).toEqual(SNAPSHOTS[backend]);
          if (backend === 'codex') {
            expect(sent.system).toBeUndefined();
            expect(sent.prompt).toContain('system: Be brief');
          } else {
            expect(sent.system).toBe('Be brief');
            expect(sent.prompt).not.toContain('system:');
          }
          if (backend === 'claude') expect(body.usage).toMatchObject({ prompt_tokens: 16, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } });
          expect(execs).toEqual([{ engine: backend, snapshot: SNAPSHOTS[backend] }]);

          const models = (await app.inject({ url: `${s.base}/models`, headers: { authorization: `Bearer ${s.key}` } })).json();
          const ids = models.data.map((m: { id: string }) => m.id);
          expect(ids).toContain(DEFAULT_MODEL[backend]);
          expect(models.data[0]).toMatchObject({ object: 'model' });
        } finally { await close(app); }
      });
    }
  }

  for (const backend of BACKENDS) {
    it(`/anthropic/v1 served by ${backend}`, async () => {
      const { app, dispatched } = await harness(backend);
      try {
        const reply = await app.inject({
          method: 'POST',
          url: '/anthropic/v1/messages',
          headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
          payload: { model: 'claude-opus-5', max_tokens: 64, system: 'Be brief', messages: [{ role: 'user', content: 'hi' }] },
        });
        expect(reply.statusCode).toBe(200);
        const body = reply.json();
        expect(body).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `from ${backend}` }] });
        expect(body.model).toBe(backend === 'claude' ? 'claude-opus-5' : DEFAULT_MODEL[backend]);

        const sent = dispatched();
        expect(sent.engine).toBe(backend);
        expect(sent.auth_json).toEqual(SNAPSHOTS[backend]);
        if (backend === 'codex') {
          expect(sent.system).toBeUndefined();
          expect(String(sent.prompt).startsWith('system: Be brief\nuser: hi')).toBe(true);
        } else {
          expect(sent.system).toBe('Be brief');
        }
        // Grok cannot take the output cap the Anthropic wire requires: not sent.
        expect(sent.max_tokens).toBe(backend === 'grok' ? undefined : 64);

        const usage = {
          codex: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          claude: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
          grok: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 },
        }[backend];
        expect(body.usage).toMatchObject(usage);
        expect(body.stop_reason).toBe(backend === 'grok' ? 'end_turn' : null);

        const models = (await app.inject({ url: '/anthropic/v1/models', headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' } })).json();
        expect(models.data[0]).toMatchObject({ type: 'model' });
        expect(models.data.map((m: { id: string }) => m.id)).toContain(DEFAULT_MODEL[backend]);
      } finally { await close(app); }
    });
  }

  it('keeps keys on the surface when the backend changes', async () => {
    const { app, runner } = await harness('claude');
    try {
      const reply = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEYS.claude}` },
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(reply.statusCode).toBe(401);
      expect(runner).not.toHaveBeenCalled();
    } finally { await close(app); }
  });

  it('applies the backend rules: Grok refuses stream and images on the Anthropic wire', async () => {
    const { app, runner } = await harness('grok');
    try {
      const headers = { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' };
      const streamed = await app.inject({
        method: 'POST', url: '/anthropic/v1/messages', headers,
        payload: { model: 'claude-opus-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(streamed.statusCode).toBe(400);
      expect(streamed.json()).toMatchObject({ type: 'error', error: { code: 'unsupported_generation_control' } });
      const image = await app.inject({
        method: 'POST', url: '/anthropic/v1/messages', headers,
        payload: { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }, { type: 'text', text: 'hi' }] }] },
      });
      expect(image.statusCode).toBe(400);
      expect(runner).not.toHaveBeenCalled();
    } finally { await close(app); }
  });

  it('answers a foreign backend\'s unknown model in the surface\'s own error spelling', async () => {
    const { app, runner } = await harness('codex');
    try {
      const reply = await app.inject({
        method: 'POST', url: '/anthropic/v1/messages', headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
        payload: { model: 'llama-3', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(reply.statusCode).toBe(404);
      expect(reply.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error', code: 'model_not_found' } });
      expect(runner).not.toHaveBeenCalled();
    } finally { await close(app); }
  });

  it('404s a model id outside the surface family instead of guessing', async () => {
    const { app, runner } = await harness('claude');
    try {
      const reply = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEYS.codex}` },
        payload: { model: 'llama-3', messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(reply.statusCode).toBe(404);
      expect(reply.json()).toMatchObject({ error: { code: 'model_not_found' } });
      const lookup = await app.inject({ url: `/v1/models/${OPENAI_DEFAULT_MODEL}`, headers: { authorization: `Bearer ${KEYS.codex}` } });
      expect(lookup.statusCode).toBe(404);
      expect(runner).not.toHaveBeenCalled();
    } finally { await close(app); }
  });
});
