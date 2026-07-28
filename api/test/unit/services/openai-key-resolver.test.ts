import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { makeOpenAiKeyResolver } from '../../../src/services/openai-key-resolver.js';
import type { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import type { RateLimitConfig, RateLimiter } from '../../../src/http/plugins/rate-limit.js';
import { ApiError } from '../../../src/http/errors.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../../src/util/engine.js';
import type { OpenaiApiKey } from '../../../src/db/schema.js';

/**
 * The resolver is the only auth gate in front of `/v1/*`, so its reject
 * branches are exercised here against fakes rather than through the route
 * suites (which all stub the happy path).
 */

interface FakeKeys {
  service: OpenAiKeyService;
  lookups: Array<{ token: string; engine: Engine }>;
  touched: number[];
}

function makeFakeKeys(record: OpenaiApiKey | null): FakeKeys {
  const lookups: Array<{ token: string; engine: Engine }> = [];
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

interface FakeLimiter {
  rateLimiter: RateLimiter;
  hits: Array<{ ip: string; bucket: string; overrides?: Partial<RateLimitConfig> }>;
}

function makeFakeLimiter(
  result: { ok: boolean; resetAt: string; count: number } = {
    ok: true,
    resetAt: new Date().toISOString(),
    count: 1,
  },
): FakeLimiter {
  const hits: FakeLimiter['hits'] = [];
  const rateLimiter: RateLimiter = {
    async hit(ip, bucket, overrides) {
      hits.push({ ip, bucket, overrides });
      return result;
    },
  };
  return { rateLimiter, hits };
}

function makeRecord(overrides: Partial<OpenaiApiKey> = {}): OpenaiApiKey {
  return {
    id: 7,
    name: 'test key',
    keyPrefix: 'sk-cdx-0123456...',
    keyHash: 'a'.repeat(64),
    keyEnc: null,
    adminUserId: null,
    rateLimitRpm: 60,
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

function makeReq(
  overrides: {
    method?: string;
    headers?: Record<string, string | string[]>;
    clientIp?: string;
  } = {},
): FastifyRequest {
  return {
    method: overrides.method ?? 'POST',
    headers: overrides.headers ?? {},
    clientIp: overrides.clientIp ?? '10.1.2.3',
  } as unknown as FastifyRequest;
}

/**
 * The hook only ever reads `req`, so we call it directly instead of dragging in
 * a reply/done pair the handler never touches.
 */
type Resolver = (req: FastifyRequest) => Promise<void>;

function makeResolver(deps: {
  keys: OpenAiKeyService;
  rateLimiter: RateLimiter;
  engine?: Engine;
}): Resolver {
  return makeOpenAiKeyResolver(deps) as unknown as Resolver;
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

describe('makeOpenAiKeyResolver', () => {
  it('lets CORS preflight through without consulting the key service', async () => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter();
    const req = makeReq({ method: 'OPTIONS', headers: { authorization: 'Bearer sk-cdx-abc' } });

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(req);

    expect(keys.lookups).toEqual([]);
    expect(keys.touched).toEqual([]);
    expect(limiter.hits).toEqual([]);
    expect(req.openaiKey).toBeUndefined();
  });

  it.each([
    ['missing', {}],
    ['bare token', { authorization: 'sk-cdx-abc' }],
    ['x-api-key scheme', { authorization: 'x-api-key sk-cdx-abc' }],
    ['x-api-key header only', { 'x-api-key': 'sk-cdx-abc' }],
    ['Basic scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['empty token', { authorization: 'Bearer' }],
    ['whitespace token', { authorization: 'Bearer    ' }],
  ])('rejects a %s Authorization header with 401', async (_label, headers) => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter();
    const resolver = makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter });

    const err = await catchApiError(() => resolver(makeReq({ headers })));

    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_api_key');
    expect(err.type).toBe('invalid_request_error');
    expect(keys.lookups).toEqual([]);
    expect(limiter.hits).toEqual([]);
  });

  it('rejects an unknown token with the same 401', async () => {
    const keys = makeFakeKeys(null);
    const limiter = makeFakeLimiter();
    const resolver = makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter });

    const err = await catchApiError(() =>
      resolver(makeReq({ headers: { authorization: 'Bearer sk-cdx-nope' } })),
    );

    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_api_key');
    expect(err.type).toBe('invalid_request_error');
    expect(keys.lookups).toEqual([{ token: 'sk-cdx-nope', engine: ENGINE_CODEX }]);
    expect(limiter.hits).toEqual([]);
  });

  it('looks the token up scoped to codex by default', async () => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter();

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(
      makeReq({ headers: { authorization: 'bearer   sk-cdx-abc  ' } }),
    );

    expect(keys.lookups).toEqual([{ token: 'sk-cdx-abc', engine: ENGINE_CODEX }]);
  });

  it('honours an explicit deps.engine', async () => {
    const keys = makeFakeKeys(makeRecord({ engine: ENGINE_CLAUDE }));
    const limiter = makeFakeLimiter();

    await makeResolver({
      keys: keys.service,
      rateLimiter: limiter.rateLimiter,
      engine: ENGINE_CLAUDE,
    })(makeReq({ headers: { authorization: 'Bearer sk-ant-abc' } }));

    expect(keys.lookups).toEqual([{ token: 'sk-ant-abc', engine: ENGINE_CLAUDE }]);
  });

  it('falls back to 60 rpm when the record carries no limit', async () => {
    const keys = makeFakeKeys(makeRecord({ id: 12, rateLimitRpm: 0 }));
    const limiter = makeFakeLimiter();

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(
      makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' }, clientIp: '198.51.100.7' }),
    );

    expect(limiter.hits).toEqual([
      {
        ip: '198.51.100.7',
        bucket: 'openai:12',
        overrides: { limit: 60, windowSeconds: 60 },
      },
    ]);
  });

  it('passes a positive rate_limit_rpm through', async () => {
    const keys = makeFakeKeys(makeRecord({ id: 3, rateLimitRpm: 5 }));
    const limiter = makeFakeLimiter();

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(
      makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' } }),
    );

    expect(limiter.hits).toEqual([
      {
        ip: '10.1.2.3',
        bucket: 'openai:3',
        overrides: { limit: 5, windowSeconds: 60 },
      },
    ]);
  });

  it('buckets an unknown client IP under 0.0.0.0', async () => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter();

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(
      makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' }, clientIp: '' }),
    );

    expect(limiter.hits[0]!.ip).toBe('0.0.0.0');
  });

  it('throws 429 with a Retry-After when the bucket is exhausted', async () => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter({
      ok: false,
      resetAt: new Date(Date.now() + 30_000).toISOString(),
      count: 61,
    });
    const resolver = makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter });
    const req = makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' } });

    const err = await catchApiError(() => resolver(req));

    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.type).toBe('rate_limit_error');
    const retryAfter = Number(err.headers!['Retry-After']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(err.message).toBe(`Rate limit exceeded. Please retry after ${retryAfter} seconds.`);
    expect(req.openaiKey).toBeUndefined();
    expect(keys.touched).toEqual([]);
  });

  it('clamps Retry-After to 1 when the window has already reset', async () => {
    const keys = makeFakeKeys(makeRecord());
    const limiter = makeFakeLimiter({
      ok: false,
      resetAt: new Date(Date.now() - 5_000).toISOString(),
      count: 61,
    });
    const resolver = makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter });

    const err = await catchApiError(() =>
      resolver(makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' } })),
    );

    expect(err.headers!['Retry-After']).toBe('1');
  });

  it('attaches the record and touches the key on success', async () => {
    const record = makeRecord({ id: 42 });
    const keys = makeFakeKeys(record);
    const limiter = makeFakeLimiter();
    const req = makeReq({ headers: { authorization: 'Bearer sk-cdx-abc' } });

    await makeResolver({ keys: keys.service, rateLimiter: limiter.rateLimiter })(req);

    expect(req.openaiKey).toBe(record);
    expect(keys.touched).toEqual([42]);
  });
});
