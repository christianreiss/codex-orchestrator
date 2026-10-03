import { describe, expect, it, vi } from 'vitest';
import {
  API_SURFACES,
  createSurfaceRouting,
  identityRouting,
  isApiSurfaceId,
  storedBackend,
} from '../../../src/services/api-surfaces.js';
import {
  createGatewayBackends,
  resolveGenerationModel,
  type GatewayBackend,
} from '../../../src/services/gateway-backends.js';
import { ApiError } from '../../../src/http/errors.js';

function fakeDb(read: () => Promise<Array<{ version: string | null }>>) {
  const limit = vi.fn(read);
  const db = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  return { db: db as never, limit };
}

describe('api surfaces', () => {
  it('keeps keys and kill switches on the surface, not the backend', () => {
    expect(API_SURFACES.openai).toMatchObject({ basePath: '/v1', keyEngine: 'codex', identityBackend: 'codex', disabledFlag: 'openai_api_disabled' });
    expect(API_SURFACES.anthropic).toMatchObject({ basePath: '/anthropic/v1', wire: 'anthropic', keyEngine: 'claude', disabledFlag: 'claude_api_disabled' });
    expect(API_SURFACES.grok).toMatchObject({ basePath: '/grok/v1', wire: 'openai', keyEngine: 'grok', disabledFlag: 'grok_api_disabled' });
    expect(isApiSurfaceId('anthropic')).toBe(true);
    expect(isApiSurfaceId('claude')).toBe(false);
  });

  it('reads a missing or unparseable backend row as the identity backend', () => {
    expect(storedBackend(null, 'openai')).toBe('codex');
    expect(storedBackend('', 'anthropic')).toBe('claude');
    expect(storedBackend('gemini', 'grok')).toBe('grok');
    expect(storedBackend(' Claude ', 'openai')).toBe('claude');
    return expect(identityRouting.backendFor('anthropic')).resolves.toBe('claude');
  });

  it('routes per request from the versions row, cached for the TTL', async () => {
    let value = 'claude';
    const { db, limit } = fakeDb(async () => [{ version: value }]);
    const routing = createSurfaceRouting(db, 60_000);
    expect(await routing.backendFor('openai')).toBe('claude');
    value = 'grok';
    expect(await routing.backendFor('openai')).toBe('claude');
    expect(limit).toHaveBeenCalledTimes(1);

    const fresh = createSurfaceRouting(db, 0);
    expect(await fresh.backendFor('openai')).toBe('grok');
  });

  it('serves the last known backend, then identity, when the read fails', async () => {
    let fail = false;
    const { db } = fakeDb(async () => {
      if (fail) throw new Error('db down');
      return [{ version: 'grok' }];
    });
    const routing = createSurfaceRouting(db, 0);
    expect(await routing.backendFor('anthropic')).toBe('grok');
    fail = true;
    expect(await routing.backendFor('anthropic')).toBe('grok');
    expect(await createSurfaceRouting(db, 0).backendFor('anthropic')).toBe('claude');
  });
});

describe('gateway backends', () => {
  const ctx = { db: {} as never, env: {} as never, keyring: {} as never };

  it('builds each engine bundle once, so Grok keeps a single auth owner', () => {
    const backends = createGatewayBackends(ctx);
    expect(backends.get('grok')).toBe(backends.get('grok'));
    expect(backends.get('codex')).not.toBe(backends.get('grok'));
  });

  function backend(engine: 'codex' | 'claude' | 'grok', ids: string[]): GatewayBackend {
    return {
      engine,
      authSnapshot: async () => null,
      onExecSuccess: () => undefined,
      models: {
        resolve: async (value) => {
          const id = typeof value === 'string' ? value.trim() : '';
          if (id === '') return ids[0]!;
          if (ids.includes(id)) return id;
          throw new ApiError('Unsupported model', { status: 404, code: 'model_not_found' });
        },
        catalog: async () => [],
        info: (id) => ({ id, display_name: id, created: 0, owned_by: engine }),
      },
    };
  }

  it('maps a native-family model id of the surface to the backend default', async () => {
    const claude = backend('claude', ['claude-sonnet-5', 'claude-opus-5']);
    expect(await resolveGenerationModel(claude, 'codex', 'gpt-5.5')).toBe('claude-sonnet-5');
    expect(await resolveGenerationModel(claude, 'codex', 'claude-opus-5')).toBe('claude-opus-5');
    expect(await resolveGenerationModel(backend('codex', ['gpt-5.5']), 'claude', 'claude-sonnet-5')).toBe('gpt-5.5');
    expect(await resolveGenerationModel(backend('grok', ['grok-4.7']), 'claude', 'claude-3-5-haiku-latest')).toBe('grok-4.7');
  });

  it('stays strict for ids outside the native family and for identity routing', async () => {
    const claude = backend('claude', ['claude-sonnet-5']);
    await expect(resolveGenerationModel(claude, 'codex', 'llama-3')).rejects.toMatchObject({ status: 404 });
    await expect(resolveGenerationModel(claude, 'claude', 'claude-nope')).rejects.toMatchObject({ status: 404 });
    await expect(resolveGenerationModel(claude, 'grok', 'gpt-5.5')).rejects.toMatchObject({ status: 404 });
  });
});
