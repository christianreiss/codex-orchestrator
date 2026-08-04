import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { OpenaiApiKey } from '../../../src/db/schema.js';
import { ApiError } from '../../../src/http/errors.js';
import { makeOpenAiKeyResolver } from '../../../src/services/openai-key-resolver.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';

interface FakeKeys {
  service: OpenAiKeyService;
  lookups: Array<{ token: string; engine: Engine }>;
  touched: number[];
}

function makeFakeKeys(record: OpenaiApiKey | null): FakeKeys {
  const lookups: FakeKeys['lookups'] = [];
  const touched: number[] = [];
  const service = {
    async findActiveByBearer(token: string, engine: Engine) {
      lookups.push({ token, engine });
      return record;
    },
    async touch(id: number) {
      touched.push(id);
    },
  } as unknown as OpenAiKeyService;
  return { service, lookups, touched };
}

function makeRecord(overrides: Partial<OpenaiApiKey> = {}): OpenaiApiKey {
  return {
    id: 7,
    name: 'test key',
    keyPrefix: 'sk-cdx-0123456...',
    keyHash: 'a'.repeat(64),
    keyEnc: null,
    adminUserId: null,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    engine: ENGINE_CODEX,
    ...overrides,
  };
}

function makeReq(method = 'POST', headers: Record<string, string | string[]> = {}): FastifyRequest {
  return { method, headers } as unknown as FastifyRequest;
}

async function catchApiError(run: () => Promise<void>): Promise<ApiError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  return caught as ApiError;
}

type Resolver = (req: FastifyRequest) => Promise<void>;

function resolver(keys: OpenAiKeyService, engine?: Engine): Resolver {
  return makeOpenAiKeyResolver({ keys, engine }) as unknown as Resolver;
}

describe('makeOpenAiKeyResolver', () => {
  it('lets CORS preflight through without consulting the key service', async () => {
    const keys = makeFakeKeys(makeRecord());
    const req = makeReq('OPTIONS', { authorization: 'Bearer sk-cdx-abc' });

    await resolver(keys.service)(req);

    expect(keys.lookups).toEqual([]);
    expect(keys.touched).toEqual([]);
    expect(req.openaiKey).toBeUndefined();
  });

  it.each([
    ['missing', {}],
    ['bare token', { authorization: 'sk-cdx-abc' }],
    ['x-api-key scheme', { authorization: 'x-api-key sk-cdx-abc' }],
    ['x-api-key header only', { 'x-api-key': 'sk-cdx-abc' }],
    ['Basic scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['empty token', { authorization: 'Bearer' }],
  ])('rejects a %s Authorization header with 401', async (_label, headers) => {
    const keys = makeFakeKeys(makeRecord());
    const resolve = resolver(keys.service);

    const err = await catchApiError(() => resolve(makeReq('POST', headers)));

    expect(err).toMatchObject({
      status: 401,
      code: 'invalid_api_key',
      type: 'invalid_request_error',
    });
    expect(keys.lookups).toEqual([]);
  });

  it('rejects an unknown token with the same 401', async () => {
    const keys = makeFakeKeys(null);
    const resolve = resolver(keys.service);

    const err = await catchApiError(() =>
      resolve(makeReq('POST', { authorization: 'Bearer sk-cdx-nope' })),
    );

    expect(err).toMatchObject({ status: 401, code: 'invalid_api_key' });
    expect(keys.lookups).toEqual([{ token: 'sk-cdx-nope', engine: ENGINE_CODEX }]);
  });

  it('honours an explicit engine', async () => {
    const keys = makeFakeKeys(makeRecord({ engine: ENGINE_CLAUDE }));

    await resolver(keys.service, ENGINE_CLAUDE)(
      makeReq('POST', { authorization: 'Bearer sk-ant-abc' }),
    );

    expect(keys.lookups).toEqual([{ token: 'sk-ant-abc', engine: ENGINE_CLAUDE }]);
  });

  it('attaches the record and touches the key on success', async () => {
    const record = makeRecord({ id: 42 });
    const keys = makeFakeKeys(record);
    const req = makeReq('POST', { authorization: 'bearer   sk-cdx-abc  ' });

    await resolver(keys.service)(req);

    expect(req.openaiKey).toBe(record);
    expect(keys.lookups).toEqual([{ token: 'sk-cdx-abc', engine: ENGINE_CODEX }]);
    expect(keys.touched).toEqual([42]);
  });
});
