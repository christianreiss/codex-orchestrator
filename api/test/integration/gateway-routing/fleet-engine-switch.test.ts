import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { ApiError } from '../../../src/http/errors.js';
import { versions } from '../../../src/db/schema.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import { registerAdminSettingsRoutes } from '../../../src/routes/admin/settings/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import { createGatewayBackends, type GatewayWiring } from '../../../src/services/gateway-backends.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { ClaudeKeyResolver } from '../../../src/services/claude-key-resolver.js';
import type { ClaudeKillSwitch } from '../../../src/services/claude-kill-switch.js';
import type { Engine } from '../../../src/util/engine.js';
import { buildRouteApp } from '../../helpers/build-route-app.js';
import { createDbFake } from '../../helpers/db-fake.js';

/**
 * An exposed API stops when the engine *serving* it is switched off
 * fleet-wide — not when the engine its name suggests is.
 */

const KEYS: Record<string, string> = { codex: 'sk-cdx-test', claude: 'sk-ant-test' };

async function harness(backends: Record<'openai' | 'anthropic', Engine>, disabled: Engine[]) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  app.decorateRequest('clientIp', '');
  app.addHook('onRequest', async (req) => { req.clientIp = '127.0.0.1'; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', output: 'hi' }))));

  const db = createDbFake(new Map([[versions, disabled.map((engine) => ({ name: `${engine}_engine_disabled`, version: '1' }))]]));
  const ctx = {
    db: db as never,
    keyring: {} as never,
    env: { AUTH_RUNNER_URL: 'http://runner/verify', AUTH_RUNNER_SHARED_SECRET: 'secret', AUTH_RUNNER_EXEC_TIMEOUT: 600 } as never,
  };
  const overrides = Object.fromEntries((['codex', 'claude', 'grok'] as Engine[]).map((engine) => [engine, {
    authSnapshot: async () => ({ tokens: { access_token: 'x' } }),
    onExecSuccess: () => undefined,
  }]));
  const gateway: GatewayWiring = {
    backends: createGatewayBackends(ctx, undefined, overrides),
    routing: { backendFor: async (surface) => backends[surface as 'openai' | 'anthropic'] },
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
  await registerAnthropicCompatRoutes(app, ctx, { gateway, keyResolver, killSwitch: claudeKillSwitch });
  await app.ready();
  return app;
}

describe('fleet engine switch on the gateways', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('503s an API whose backend is switched off, in that API wire shape', async () => {
    const app = await harness({ openai: 'codex', anthropic: 'claude' }, ['claude']);
    try {
      const reply = await app.inject({
        method: 'POST',
        url: '/anthropic/v1/messages',
        headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' },
        payload: { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
      expect(reply.body).toContain('disabled fleet-wide');
    } finally {
      await app.close();
    }
  });

  it('keeps serving an API whose name matches the disabled engine but whose backend does not', async () => {
    // /anthropic/v1 rerouted to Codex survives Claude being switched off.
    const app = await harness({ openai: 'codex', anthropic: 'codex' }, ['claude']);
    try {
      const reply = await app.inject({ method: 'GET', url: '/anthropic/v1/models', headers: { 'x-api-key': KEYS.claude, 'anthropic-version': '2023-06-01' } });
      expect(reply.statusCode, reply.body).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('503s /v1 when it is routed to the disabled engine', async () => {
    const app = await harness({ openai: 'claude', anthropic: 'claude' }, ['claude']);
    try {
      const reply = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${KEYS.codex}` } });
      expect(reply.statusCode).toBe(503);
      expect(reply.json()).toMatchObject({ error: { code: 'api_disabled' } });
    } finally {
      await app.close();
    }
  });

  it('refuses to route an API onto a disabled backend, but lets it stay where it is', async () => {
    const app = await buildRouteApp();
    const db = createDbFake(new Map([[versions, [
      { name: 'claude_engine_disabled', version: '1' },
      { name: 'api_surface_backend_anthropic', version: 'claude' },
    ]]]));
    await registerAdminSettingsRoutes(app, { db: db as never, env: {} as never, keyring: {} as never } as RouteContext);
    try {
      const moveOnto = await app.inject({ method: 'POST', url: '/admin/api/surfaces/openai', payload: { backend: 'claude' } });
      expect(moveOnto.statusCode).toBe(409);
      expect(moveOnto.json()).toMatchObject({ code: 'engine_disabled', scope: 'fleet', engine: 'claude' });
      const stay = await app.inject({ method: 'POST', url: '/admin/api/surfaces/anthropic', payload: { backend: 'claude' } });
      expect(stay.statusCode).toBe(200);
      const moveOff = await app.inject({ method: 'POST', url: '/admin/api/surfaces/anthropic', payload: { backend: 'codex' } });
      expect(moveOff.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
