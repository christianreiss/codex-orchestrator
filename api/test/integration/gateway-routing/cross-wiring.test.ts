import { request as httpRequest, type ClientRequest } from 'node:http';
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
import { CLAUDE_MODEL_LINES, type ClaudeModel } from '../../../src/services/claude-models.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { ClaudeKeyResolver } from '../../../src/services/claude-key-resolver.js';
import type { ClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import { versions } from '../../../src/db/schema.js';
import { createDbFake } from '../../helpers/db-fake.js';
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
  const info = (id: string) => ({
    id, display_name: id, created: 1_767_225_600, owned_by: owner,
    ...(engine === 'claude' ? { line: CLAUDE_MODEL_LINES[id as ClaudeModel] } : {}),
  });
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

async function harness(backend: Engine, opts: { assigned?: Engine; disabled?: Engine[]; endpointDisabled?: boolean } = {}) {
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
    db: createDbFake(new Map([[versions, (opts.disabled ?? []).map(engine => ({ name: `${engine}_engine_disabled`, version: '1' }))]])) as never,
    keyring: {} as never,
    env: { AUTH_RUNNER_URL: 'http://runner/verify', AUTH_RUNNER_SHARED_SECRET: 'secret', AUTH_RUNNER_EXEC_TIMEOUT: 600 } as never,
  };
  const overrides = Object.fromEntries(BACKENDS.map((engine) => [engine, {
    authSnapshot: async () => SNAPSHOTS[engine],
    onExecSuccess: (snapshot: unknown) => { execs.push({ engine, snapshot }); },
    ...(engine === 'codex' ? {} : { models: stubModels(engine) }),
  }]));
  const routingCalls = vi.fn(async () => backend);
  const gateway: GatewayWiring = {
    backends: createGatewayBackends(ctx, undefined, overrides),
    routing: { backendFor: routingCalls },
  };

  const keys = {
    findActiveByBearer: async (token: string, engine: string) => (KEYS[engine] === token ? { id: 1, engine, backendEngine: opts.assigned } : null),
    touch: async () => undefined,
  } as unknown as OpenAiKeyService;
  const ensureEndpoint = async () => { if (opts.endpointDisabled) throw new ApiError('Endpoint disabled', { status: 503, code: 'api_disabled', type: 'api_error' }); };
  const killSwitch = { isDisabled: async () => Boolean(opts.endpointDisabled), throwIfDisabled: ensureEndpoint };
  const keyResolver: ClaudeKeyResolver = {
    resolve: async () => ({ id: 1, name: 'test', keyPrefix: 'sk-ant-', adminUserId: null }),
    preHandler: async (req) => {
      if (req.headers['x-api-key'] !== KEYS.claude) {
        throw new ApiError('Invalid API key.', { status: 401, code: 'invalid_api_key', type: 'authentication_error' });
      }
      req.claudeApiKey = { backendEngine: opts.assigned, id: 1, name: 'test', keyPrefix: 'sk-ant-', adminUserId: null };
    },
  };
  const claudeKillSwitch: ClaudeKillSwitch = { isDisabled: async () => false, ensureEnabled: ensureEndpoint, setDisabled: async () => undefined };

  await registerOpenAiCompatRoutes(app, ctx, { gateway, keys, killSwitch });
  await registerGrokCompatRoutes(app, ctx, { gateway, keys, killSwitch });
  await registerAnthropicCompatRoutes(app, ctx, { gateway, keyResolver, killSwitch: claudeKillSwitch });
  await app.ready();
  const dispatched = () => JSON.parse(String(runner.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>;
  return { app, runner, dispatched, execs, routingCalls };
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

  const ALL_SURFACES = [
    ...OPENAI_SURFACES.map(s => ({ ...s, headers: { authorization: `Bearer ${s.key}` } as Record<string, string>, generate: '/chat/completions' })),
    { surface: 'anthropic', base: '/anthropic/v1', headers: { 'x-api-key': KEYS.claude!, 'anthropic-version': '2023-06-01' }, generate: '/messages' },
  ];

  for (const surface of ALL_SURFACES) for (const assigned of BACKENDS) {
    it(`${surface.base}: assigned ${assigned} overrides a disabled endpoint default for models and generation`, async () => {
      const fallback = BACKENDS.find(engine => engine !== assigned)!;
      const { app, dispatched, routingCalls } = await harness(fallback, { assigned, disabled: [fallback] });
      try {
        const headers = surface.headers;
        const models = await app.inject({ url: `${surface.base}/models`, headers });
        expect(models.statusCode, models.body).toBe(200);
        expect(models.json().data.map((m: { id: string }) => m.id)).toContain(DEFAULT_MODEL[assigned]);
        const reply = await app.inject({ method: 'POST', url: `${surface.base}${surface.generate}`, headers,
          payload: { model: DEFAULT_MODEL[assigned], messages: [{ role: 'user', content: 'hi' }], ...(surface.surface === 'anthropic' ? { max_tokens: 64 } : {}) } });
        expect(reply.statusCode, reply.body).toBe(200);
        expect(dispatched()).toMatchObject({ engine: assigned, auth_json: SNAPSHOTS[assigned] });
        expect(routingCalls).not.toHaveBeenCalled();
        if (assigned === 'grok') {
          const streaming = await app.inject({ method: 'POST', url: `${surface.base}${surface.generate}`, headers,
            payload: { stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 } });
          expect(streaming.statusCode).toBe(400);
        }
      } finally { await close(app); }
    });

    it(`${surface.base}: refuses disabled assigned ${assigned} without falling back`, async () => {
      const fallback = BACKENDS.find(engine => engine !== assigned)!;
      const { app, runner, routingCalls } = await harness(fallback, { assigned, disabled: [assigned] });
      try {
        const reply = await app.inject({ url: `${surface.base}/models`, headers: surface.headers });
        expect(reply.statusCode).toBe(503);
        expect(reply.json()).toMatchObject({ error: { type: surface.surface === 'anthropic' ? 'api_error' : 'server_error' } });
        expect(runner).not.toHaveBeenCalled();
        expect(routingCalls).not.toHaveBeenCalled();
      } finally { await close(app); }
    });
  }

  for (const surface of ALL_SURFACES) {
    it(`${surface.base}: endpoint switch still blocks assigned keys`, async () => {
      const { app, runner } = await harness('codex', { assigned: 'claude', endpointDisabled: true });
      try {
        const reply = await app.inject({ url: `${surface.base}/models`, headers: surface.headers });
        expect(reply.statusCode).toBe(503);
        expect(runner).not.toHaveBeenCalled();
      } finally { await close(app); }
    });
    it(`${surface.base}: legacy key resolves routing once per request`, async () => {
      const { app, routingCalls } = await harness('codex');
      try {
        const reply = await app.inject({ url: `${surface.base}/models`, headers: surface.headers });
        expect(reply.statusCode, reply.body).toBe(200);
        expect(routingCalls).toHaveBeenCalledTimes(1);
      } finally { await close(app); }
    });
  }

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

  for (const backend of BACKENDS) {
    it(`/anthropic/v1 applies anthropic-version 2026-10-21 at the surface when served by ${backend}`, async () => {
      const { app, runner, dispatched } = await harness(backend);
      try {
        const headers = { 'x-api-key': KEYS.claude, 'anthropic-version': '2026-10-21' };
        const ok = await app.inject({
          method: 'POST', url: '/anthropic/v1/messages', headers,
          payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
        });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(dispatched().engine).toBe(backend);
        expect(runner).toHaveBeenCalledTimes(1);
        for (const param of ['temperature', 'top_p', 'top_k']) {
          const removed = await app.inject({
            method: 'POST', url: '/anthropic/v1/messages', headers,
            payload: { max_tokens: 64, [param]: 1, messages: [{ role: 'user', content: 'hi' }] },
          });
          expect(removed.statusCode).toBe(400);
          expect(removed.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', code: 'unsupported_in_api_version' } });
        }
        expect(runner).toHaveBeenCalledTimes(1);
        const count = await app.inject({ method: 'POST', url: '/anthropic/v1/messages/count_tokens', headers, payload: { messages: [{ role: 'user', content: 'hi' }] } });
        expect(count.statusCode, count.body).toBe(200);
        const models = await app.inject({ url: '/anthropic/v1/models', headers });
        expect(models.statusCode, models.body).toBe(200);
        for (const model of models.json().data) expect(model).toHaveProperty('line');
        // Only the Claude backend's catalog carries Anthropic model lines.
        for (const model of models.json().data) {
          if (backend === 'claude') expect(model.line).toBe(CLAUDE_MODEL_LINES[model.id as ClaudeModel]);
          else expect(model.line).toBeNull();
        }
      } finally { await close(app); }
    });

    it(`rejects malformed stream values before executing ${backend} on every generation route`, async () => {
      const { app, runner } = await harness(backend);
      try {
        const routes = [
          ...OPENAI_SURFACES.flatMap((surface) => [
            { url: `${surface.base}/chat/completions`, headers: { authorization: `Bearer ${surface.key}` } },
            { url: `${surface.base}/completions`, headers: { authorization: `Bearer ${surface.key}` } },
            { url: `${surface.base}/responses`, headers: { authorization: `Bearer ${surface.key}` } },
          ]),
          ...['messages', 'complete', 'completions', 'responses'].map((route) => ({
            url: `/anthropic/v1/${route}`,
            headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
          })),
        ];
        for (const route of routes) {
          for (const stream of [1, 0, 'true', 'false', '', {}, []]) {
            const reply = await app.inject({
              method: 'POST', ...route,
              payload: { messages: [{ role: 'user', content: 'hi' }], input: 'hi', prompt: 'hi', stream },
            });
            expect(reply.statusCode, `${route.url}: stream=${JSON.stringify(stream)}`).toBe(400);
            expect(reply.json()).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_stream' } });
            if (!route.url.startsWith('/anthropic/')) expect(reply.json().error.param).toBe('stream');
            expect(runner).not.toHaveBeenCalled();
          }
        }
      } finally { await close(app); }
    });

    it(`treats stream:null as omitted on every generation route served by ${backend}`, async () => {
      const { app, runner } = await harness(backend);
      try {
        const routes = [
          ...OPENAI_SURFACES.flatMap((surface) => ['chat/completions', 'completions', 'responses'].map((path) => ({
            url: `${surface.base}/${path}`, headers: { authorization: `Bearer ${surface.key}` },
            payload: { messages: [{ role: 'user', content: 'hi' }], prompt: 'hi', input: 'hi', stream: null },
          }))),
          ...['messages', 'complete', 'completions', 'responses'].map((path) => ({
            url: `/anthropic/v1/${path}`, headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
            payload: { messages: [{ role: 'user', content: 'hi' }], prompt: 'hi', input: 'hi', max_tokens: 64, stream: null },
          })),
        ];
        for (const route of routes) {
          const reply = await app.inject({ method: 'POST', ...route });
          expect(reply.statusCode, route.url).toBe(200);
          expect(reply.headers['content-type']).toContain('application/json');
        }
        expect(runner).toHaveBeenCalledTimes(routes.length);
      } finally { await close(app); }
    });

    it(`keeps unknown stop reasons null for legacy Anthropic completions served by ${backend}`, async () => {
      const { app } = await harness(backend);
      try {
        for (const route of ['complete', 'completions']) {
          const reply = await app.inject({
            method: 'POST', url: `/anthropic/v1/${route}`,
            headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
            payload: { prompt: 'hi', stream: false },
          });
          expect(reply.statusCode).toBe(200);
          expect(reply.json().stop_reason).toBe(backend === 'grok' ? 'stop_sequence' : null);
        }
      } finally { await close(app); }
    });
  }

  for (const backend of ['codex', 'claude'] as const) {
    it(`keeps ${backend}'s unknown stop reasons null in synthesized SSE`, async () => {
      const { app } = await harness(backend);
      try {
        for (const surface of OPENAI_SURFACES) {
          const reply = await app.inject({
            method: 'POST', url: `${surface.base}/chat/completions`,
            headers: { authorization: `Bearer ${surface.key}` },
            payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
          });
          expect(reply.statusCode).toBe(200);
          expect(reply.body).toContain('data: [DONE]');
          const events = reply.body.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
          expect(events.at(-1).choices[0].finish_reason).toBeNull();
        }
        for (const route of ['messages', 'complete', 'completions']) {
          const reply = await app.inject({
            method: 'POST', url: `/anthropic/v1/${route}`,
            headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
            payload: { max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], prompt: 'hi', stream: true },
          });
          expect(reply.statusCode).toBe(200);
          const events = reply.body.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
          expect(events.find((event) => event.type === 'message_delta').delta.stop_reason).toBeNull();
          expect(events.at(-1).type).toBe('message_stop');
        }
      } finally { await close(app); }
    });
  }

  for (const backend of BACKENDS) {
    for (const stop of ['disconnect', 'shutdown'] as const) {
      it(`cancels ${backend} generation on ${stop} across every wire route`, async () => {
        const routes = [
          ...OPENAI_SURFACES.flatMap((surface) => [
            { url: `${surface.base}/chat/completions`, headers: { authorization: `Bearer ${surface.key}` }, payload: { messages: [{ role: 'user', content: 'hi' }] } },
            { url: `${surface.base}/completions`, headers: { authorization: `Bearer ${surface.key}` }, payload: { prompt: 'hi' } },
            { url: `${surface.base}/responses`, headers: { authorization: `Bearer ${surface.key}` }, payload: { input: 'hi' } },
          ]),
          ...['messages', 'complete', 'completions', 'responses'].map((route) => ({
            url: `/anthropic/v1/${route}`,
            headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
            payload: { messages: [{ role: 'user', content: 'hi' }], prompt: 'hi', input: 'hi', max_tokens: 64 },
          })),
        ];
        for (const route of routes) {
          const { app, runner, execs } = await harness(backend);
          let request: ClientRequest | undefined;
          let cancelPending: ((reason: unknown) => void) | undefined;
          runner.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            cancelPending = reject;
            const signal = init!.signal!;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }));
          try {
            const address = await app.listen({ host: '127.0.0.1', port: 0 });
            request = httpRequest(`${address}${route.url}`, {
              method: 'POST', agent: false, headers: { ...route.headers, 'content-type': 'application/json' },
            }, (response) => response.resume());
            request.on('error', () => undefined);
            request.end(JSON.stringify(route.payload));
            await vi.waitFor(() => expect(runner, route.url).toHaveBeenCalledTimes(1));
            const signal = runner.mock.calls[0]![1]!.signal!;
            let closing: Promise<void> | undefined;
            if (stop === 'disconnect') request.destroy();
            else closing = app.close();
            await vi.waitFor(() => expect(signal.aborted, route.url).toBe(true));
            expect(signal.reason).toMatchObject({ code: stop === 'disconnect' ? 'request_cancelled' : 'gateway_stopping' });
            if (closing) await closing;
            expect(execs).toEqual([]);
          } finally {
            cancelPending?.(new Error('test cleanup'));
            request?.destroy();
            await close(app);
          }
        }
      });
    }
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
