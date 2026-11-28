/**
 * The `upstream` source end to end: real routes, real key resolvers, real
 * owner state and owner response boundary, real undici agent, against a local
 * `node:http` fake provider on 127.0.0.1 (listed as a private host).
 */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { request } from 'undici';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { requestIdPlugin } from '../../../src/http/plugins/request-id.js';
import { installOwnerResponseBoundary } from '../../../src/http/plugins/owner-response.js';
import { withOwnerRequestScope } from '../../../src/control-plane/state/runtime.js';
import { registerOpenAiCompatRoutes } from '../../../src/routes/v1/index.js';
import { registerAnthropicCompatRoutes } from '../../../src/routes/anthropic-v1/index.js';
import { registerGrokCompatRoutes } from '../../../src/routes/grok-v1/index.js';
import { registerKimiCompatRoutes } from '../../../src/routes/kimi-v1/index.js';
import { OpenAiKeyService } from '../../../src/services/openai-keys.js';
import { createGatewayBackends, type GatewayWiring } from '../../../src/services/gateway-backends.js';
import { createSurfaceRouting } from '../../../src/services/api-surfaces.js';
import { createGatewayUpstream, type GatewayUpstream } from '../../../src/services/gateway-upstream/index.js';
import { upstreamConfigFromEnv, type UpstreamConfig } from '../../../src/services/gateway-upstream/client.js';
import type { ProviderId } from '../../../src/services/gateway-upstream/providers.js';
import { sha256 } from '../../../src/security/hash.js';
import { memoryOwner, type MemoryOwner } from '../../helpers/memory-owner.js';
import { testKeyring } from '../../helpers/test-keyring.js';

const GW = `sk-cdx-${'1'.repeat(64)}`; // unpinned: follows the surface default
const GW_UP = `sk-cdx-${'2'.repeat(64)}`; // pinned upstream
const GW_EMU = `sk-cdx-${'3'.repeat(64)}`; // pinned emulated
const GW_ANT = `sk-ant-${'4'.repeat(64)}`; // Anthropic namespace, pinned upstream
const GW_GROK = `sk-cgx-${'5'.repeat(64)}`;
const GW_KIMI = `sk-ckx-${'6'.repeat(64)}`;
const KEY_A = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function gatewayKey(id: number, key: string, engine: string, source: string | null) {
  return {
    id,
    name: `key-${id}`,
    keyPrefix: `${key.slice(0, 16)}...`,
    keyHash: sha256(key),
    adminUserId: null,
    isActive: 1,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    engine,
    backendEngine: null,
    source,
  };
}

const GATEWAY_KEYS = [
  gatewayKey(1, GW, 'codex', null),
  gatewayKey(2, GW_UP, 'codex', 'upstream'),
  gatewayKey(3, GW_EMU, 'codex', 'emulated'),
  gatewayKey(4, GW_ANT, 'claude', 'upstream'),
  gatewayKey(5, GW_GROK, 'grok', 'upstream'),
  gatewayKey(6, GW_KIMI, 'kimi', 'upstream'),
];

function setting(name: string, version: string) {
  return { name, version, updatedAt: '2026-01-01T00:00:00Z' };
}

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface FakeProvider {
  base: string;
  seen: Seen[];
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeProvider(handler: (seen: Seen, res: http.ServerResponse) => void | Promise<void>): Promise<FakeProvider> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(entry);
    try {
      await handler(entry, res);
    } catch {
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(close);
  return { base: `http://127.0.0.1:${port}/v1`, seen, close };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function keyOf(seen: Seen): string | undefined {
  const auth = seen.headers.authorization;
  return typeof auth === 'string' ? auth.replace(/^Bearer /, '') : (seen.headers['x-api-key'] as string | undefined);
}

interface Harness extends MemoryOwner {
  app: FastifyInstance;
  upstream: GatewayUpstream;
  gatewayKeys: OpenAiKeyService;
  addKey(provider: ProviderId, key: string, baseUrl: string): Promise<number>;
}

async function harness(options: { settings?: Array<[string, string]>; config?: Partial<UpstreamConfig> } = {}): Promise<Harness> {
  const owner = memoryOwner({
    openaiApiKeys: GATEWAY_KEYS,
    versions: [setting('kimi_api_disabled', '0'), ...(options.settings ?? []).map(([name, value]) => setting(name, value))],
  });
  cleanups.push(() => owner.close());
  const keyring = testKeyring();
  const ctx = { db: owner.db, env: {} as never, keyring };
  const config = { ...upstreamConfigFromEnv({ GATEWAY_UPSTREAM_PRIVATE_HOSTS: '127.0.0.1' } as never), ...options.config };
  const upstream = createGatewayUpstream(ctx, { config });
  cleanups.push(() => upstream.close());
  const gateway: GatewayWiring = { backends: createGatewayBackends(ctx), routing: createSurfaceRouting(owner.db), upstream };

  const app = Fastify({ logger: false });
  app.decorateRequest('clientIp', '127.0.0.1');
  app.addHook('onRequest', (_req, _reply, done) => withOwnerRequestScope(done));
  installOwnerResponseBoundary(app, owner.owner);
  await app.register(cookie);
  await app.register(requestIdPlugin);
  await app.register(envelopePlugin);
  await registerOpenAiCompatRoutes(app, ctx, { gateway });
  await registerAnthropicCompatRoutes(app, ctx, { gateway });
  await registerGrokCompatRoutes(app, ctx, { gateway });
  await registerKimiCompatRoutes(app, ctx, { gateway });
  await app.ready();
  cleanups.push(() => app.close());

  return {
    ...owner,
    app,
    upstream,
    gatewayKeys: new OpenAiKeyService({ db: owner.db, keyring }),
    async addKey(provider, key, baseUrl) {
      return (await upstream.keys.create({ provider, label: `${provider} key`, key, base_url: baseUrl })).id;
    },
  };
}

const ok = (body = '{"ok":true}') => (_seen: Seen, res: http.ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
};

describe('gateway upstream source', () => {
  it('forwards the exact bytes with the provider key and applies the header policy both ways', async () => {
    const answer = '{"id":"chatcmpl-1",   "weird":"spacing ✓"}';
    const provider = await fakeProvider((_seen, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_up_1',
        'openai-organization': 'org-secret',
        'openai-project': 'proj_secret',
        'set-cookie': '__cf_bm=abc',
        server: 'cloudflare',
        'cf-ray': '123-FRA',
        'x-ratelimit-remaining-requests': '99',
        'openai-processing-ms': '12',
      });
      res.end(answer);
    });
    const h = await harness();
    await h.addKey('openai', KEY_A, provider.base);
    const body = '{"model":"gpt-x",\n  "messages":[{"role":"user","content":"héllo"}], "extra_field": 1}';

    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions?trace=1',
      headers: {
        authorization: `Bearer ${GW_UP}`,
        'content-type': 'application/json',
        'openai-organization': 'org-client',
        'openai-project': 'proj-client',
        cookie: 'session=1',
        'x-forwarded-for': '203.0.113.9',
        'x-stainless-lang': 'js',
        'idempotency-key': 'idem-1',
      },
      payload: body,
    });

    expect(r.statusCode).toBe(200);
    expect(r.payload).toBe(answer);
    expect(r.headers['x-request-id']).toBe('req_up_1');
    expect(r.headers['x-gateway-request-id']).toEqual(expect.any(String));
    expect(r.headers['x-gateway-request-id']).not.toBe('req_up_1');
    expect(r.headers['x-ratelimit-remaining-requests']).toBe('99');
    expect(r.headers['openai-processing-ms']).toBe('12');
    for (const stripped of ['openai-organization', 'openai-project', 'set-cookie', 'server', 'cf-ray']) {
      expect(r.headers[stripped]).toBeUndefined();
    }

    expect(provider.seen).toHaveLength(1);
    const seen = provider.seen[0]!;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1/chat/completions?trace=1');
    expect(seen.body.equals(Buffer.from(body))).toBe(true);
    expect(seen.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(seen.headers['x-stainless-lang']).toBe('js');
    expect(seen.headers['idempotency-key']).toBe('idem-1');
    for (const dropped of ['openai-organization', 'openai-project', 'cookie', 'x-forwarded-for', 'x-api-key']) {
      expect(seen.headers[dropped]).toBeUndefined();
    }
  });

  it('follows the surface default for unpinned keys and honours an emulated pin', async () => {
    const provider = await fakeProvider(ok());
    const emulated = await harness();
    await emulated.addKey('openai', KEY_A, provider.base);
    const asEmulated = await emulated.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${GW}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(asEmulated.statusCode).toBe(400);
    expect(JSON.parse(asEmulated.payload).error.code).toBe('unsupported_endpoint');
    expect(provider.seen).toHaveLength(0);

    const upstream = await harness({ settings: [['api_surface_source_openai', 'upstream']] });
    await upstream.addKey('openai', KEY_A, provider.base);
    const forwarded = await upstream.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${GW}`, 'content-type': 'application/json' },
      payload: '{"input":"x"}',
    });
    expect(forwarded.statusCode).toBe(200);
    expect(provider.seen.map((s) => s.url)).toEqual(['/v1/embeddings']);

    const pinned = await upstream.app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${GW_EMU}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(pinned.statusCode).toBe(400);
    expect(provider.seen).toHaveLength(1);
  });

  it('fails over on 401, cools the key, and only a re-verification marks it invalid', async () => {
    const provider = await fakeProvider((seen, res) => {
      if (keyOf(seen) === KEY_A) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Incorrect API key provided: sk-proj-AAAA"}}');
        return;
      }
      ok('{"from":"b"}')(seen, res);
    });
    const h = await harness();
    const a = await h.addKey('openai', KEY_A, provider.base);
    await h.addKey('openai', KEY_B, provider.base);

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
      payload: '{"model":"m"}',
    });
    expect(first.statusCode).toBe(200);
    expect(first.payload).toBe('{"from":"b"}');

    await vi.waitFor(async () => expect((await h.upstream.keys.get(a))?.verificationState).toBe('invalid'));
    const verify = provider.seen.find((s) => s.method === 'GET' && s.url === '/v1/models');
    expect(verify && keyOf(verify)).toBe(KEY_A);
    const invalid = await h.upstream.keys.get(a);
    expect(invalid?.verificationReason).toBe('unauthorized (HTTP 401)');
    expect(JSON.stringify(invalid)).not.toContain('Incorrect API key');

    provider.seen.length = 0;
    const second = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
      payload: '{"model":"m"}',
    });
    expect(second.statusCode).toBe(200);
    expect(provider.seen.map(keyOf)).toEqual([KEY_B]);
  });

  it('passes the last key\'s 429 through and tries a rate-limited key last next time', async () => {
    const provider = await fakeProvider((seen, res) => {
      if (keyOf(seen) === KEY_A) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end('{"error":{"type":"rate_limit"}}');
        return;
      }
      ok()(seen, res);
    });
    const single = await harness();
    await single.addKey('openai', KEY_A, provider.base);
    const limited = await single.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('7');
    expect(limited.payload).toBe('{"error":{"type":"rate_limit"}}');

    provider.seen.length = 0;
    const two = await harness();
    await two.addKey('openai', KEY_A, provider.base);
    await two.addKey('openai', KEY_B, provider.base);
    const send = () =>
      two.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
        payload: '{}',
      });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(provider.seen.map(keyOf)).toEqual([KEY_A, KEY_B, KEY_B]);
  });

  it('stays on the key that answered (sticky round robin), wraps around, and leaves the pointer on a pass-through', async () => {
    const KEY_C = 'sk-proj-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const failing = new Set<string>([KEY_A]);
    const provider = await fakeProvider((seen, res) => {
      if (failing.has(keyOf(seen) ?? '')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"error":{"type":"forbidden"}}');
        return;
      }
      ok(`{"from":"${keyOf(seen)?.slice(8, 9)}"}`)(seen, res);
    });
    const h = await harness();
    const a = await h.addKey('openai', KEY_A, provider.base);
    const b = await h.addKey('openai', KEY_B, provider.base);
    const c = await h.addKey('openai', KEY_C, provider.base);
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
        payload: '{}',
      });

    // Key A fails, B answers and becomes current.
    expect((await send()).payload).toBe('{"from":"B"}');
    await vi.waitFor(async () => expect(await h.upstream.keys.currentKeyId('openai')).toBe(b));
    // A recovers, but the gateway stays on B.
    failing.clear();
    provider.seen.length = 0;
    expect((await send()).payload).toBe('{"from":"B"}');
    expect(provider.seen.map(keyOf)).toEqual([KEY_B]);

    // B fails: C takes over; C fails: the order wraps around to A.
    failing.add(KEY_B);
    expect((await send()).payload).toBe('{"from":"C"}');
    await vi.waitFor(async () => expect(await h.upstream.keys.currentKeyId('openai')).toBe(c));
    failing.add(KEY_C);
    provider.seen.length = 0;
    expect((await send()).payload).toBe('{"from":"A"}');
    expect(provider.seen.map(keyOf)).toEqual([KEY_C, KEY_A]);
    await vi.waitFor(async () => expect(await h.upstream.keys.currentKeyId('openai')).toBe(a));

    // Every key refuses: the last answer passes through and the pointer stays.
    failing.add(KEY_A);
    expect((await send()).statusCode).toBe(403);
    expect(await h.upstream.keys.currentKeyId('openai')).toBe(a);
  });

  it('moves the pointer only from the value a request started with', async () => {
    const provider = await fakeProvider(ok());
    const h = await harness();
    const a = await h.addKey('openai', KEY_A, provider.base);
    const b = await h.addKey('openai', KEY_B, provider.base);
    expect(await h.upstream.keys.setCurrent(b, { reason: 'failover', expected: null })).toEqual({ provider: 'openai', changed: true });
    // A request that began while A was still current must not move it back.
    expect(await h.upstream.keys.setCurrent(a, { reason: 'failover', expected: null })).toEqual({ provider: 'openai', changed: false });
    expect(await h.upstream.keys.currentKeyId('openai')).toBe(b);
    // A paused key is never made current by a failover.
    await h.upstream.keys.setState(a, 'paused');
    expect(await h.upstream.keys.setCurrent(a, { reason: 'failover', expected: b })).toEqual({ provider: 'openai', changed: false });
  });

  it('fails over on a connection failure and reports 502 when no key connects', async () => {
    const provider = await fakeProvider(ok());
    const dead = `http://127.0.0.1:${await closedPort()}/v1`;
    const h = await harness();
    await h.addKey('openai', KEY_A, dead);
    const lone = await h.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${GW_UP}` },
    });
    expect(lone.statusCode).toBe(502);
    expect(JSON.parse(lone.payload).error.code).toBe('upstream_unreachable');

    await h.addKey('openai', KEY_B, provider.base);
    const recovered = await h.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${GW_UP}` },
    });
    expect(recovered.statusCode).toBe(200);
    expect(provider.seen.map(keyOf)).toEqual([KEY_B]);
  });

  it('commits a 5xx without trying the next key', async () => {
    const provider = await fakeProvider((_seen, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    const h = await harness();
    await h.addKey('openai', KEY_A, provider.base);
    await h.addKey('openai', KEY_B, provider.base);
    const r = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(r.statusCode).toBe(500);
    expect(r.payload).toBe('boom');
    expect(provider.seen.map(keyOf)).toEqual([KEY_A]);
  });

  it('does not repeat a request on another key once the connection drops after sending it', async () => {
    const provider = await fakeProvider((_seen, res) => {
      res.socket?.destroy();
    });
    const h = await harness();
    await h.addKey('openai', KEY_A, provider.base);
    await h.addKey('openai', KEY_B, provider.base);
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
      payload: '{"model":"gpt-x","messages":[]}',
    });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.payload).error.code).toBe('upstream_connection_lost');
    expect(provider.seen.map(keyOf)).toEqual([KEY_A]);
  });

  it('does not repeat a request whose answer cannot be parsed', async () => {
    let requests = 0;
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        requests += 1;
        socket.end('HTTP/1.1 abc\r\n\r\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const h = await harness();
    await h.addKey('openai', KEY_A, base);
    await h.addKey('openai', KEY_B, base);
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
      payload: '{"model":"gpt-x","messages":[]}',
    });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.payload).error.code).toBe('upstream_connection_lost');
    expect(requests).toBe(1);
  });

  it('answers 504 when the provider sends no headers in time', async () => {
    const provider = await fakeProvider(() => new Promise<void>(() => undefined));
    const h = await harness({ config: { headersTimeoutMs: 200 } });
    await h.addKey('openai', KEY_A, provider.base);
    const r = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(r.statusCode).toBe(504);
    expect(JSON.parse(r.payload).error.code).toBe('upstream_timeout');
  });

  it('refuses before forwarding: kill switch, provider engine switch, no usable key', async () => {
    const provider = await fakeProvider(ok());
    const killed = await harness({ settings: [['openai_api_disabled', '1']] });
    await killed.addKey('openai', KEY_A, provider.base);
    for (const [url, headers] of [
      ['/v1/files', {}],
      ['/v1/models', { authorization: `Bearer ${GW_UP}` }],
    ] as const) {
      const r = await killed.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(503);
      expect(JSON.parse(r.payload).error.code).toBe('api_disabled');
    }

    const engineOff = await harness({ settings: [['codex_engine_disabled', '1']] });
    await engineOff.addKey('openai', KEY_A, provider.base);
    const off = await engineOff.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(off.statusCode).toBe(503);
    expect(JSON.parse(off.payload).error).toMatchObject({ code: 'api_disabled' });
    expect(JSON.parse(off.payload).error.message).toContain('OpenAI belongs to the Codex engine');

    const empty = await harness();
    const none = await empty.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(none.statusCode).toBe(503);
    expect(JSON.parse(none.payload).error.code).toBe('upstream_unconfigured');

    const paused = await harness();
    const id = await paused.addKey('openai', KEY_A, provider.base);
    await paused.upstream.keys.setState(id, 'paused');
    const r = await paused.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(JSON.parse(r.payload).error.code).toBe('upstream_unconfigured');
    expect(provider.seen).toHaveLength(0);
  });

  it('serves every other path through the catch-alls, 404 when emulated', async () => {
    const provider = await fakeProvider((seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(seen.method === 'HEAD' ? undefined : JSON.stringify({ method: seen.method, url: seen.url }));
    });
    const h = await harness();
    await h.addKey('openai', KEY_A, provider.base);

    const anonymous = await h.app.inject({ method: 'GET', url: '/v1/files' });
    expect(anonymous.statusCode).toBe(404);
    expect(JSON.parse(anonymous.payload).error.code).toBe('not_found');
    // An edge proxy that copies a missing Authorization sends it empty.
    for (const headers of [{ authorization: '' }, { authorization: '  ', 'x-api-key': '' }]) {
      const blank = await h.app.inject({ method: 'GET', url: '/v1/files', headers });
      expect(blank.statusCode).toBe(404);
    }
    const badKey = await h.app.inject({ method: 'GET', url: '/v1/files', headers: { authorization: 'Bearer sk-nope' } });
    expect(badKey.statusCode).toBe(401);
    const emulatedKey = await h.app.inject({ method: 'GET', url: '/v1/files', headers: { authorization: `Bearer ${GW}` } });
    expect(emulatedKey.statusCode).toBe(404);
    expect(provider.seen).toHaveLength(0);

    // Stainless SDKs name a JSON content type on bodyless requests.
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/files?purpose=batch',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.payload)).toEqual({ method: 'GET', url: '/v1/files?purpose=batch' });

    const boundary = 'fleetboundary';
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      binary,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await h.app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { authorization: `Bearer ${GW_UP}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(upload.statusCode).toBe(200);
    const sent = provider.seen.at(-1)!;
    expect(sent.headers['content-type']).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(sent.body.equals(multipart)).toBe(true);

    for (const method of ['HEAD', 'DELETE', 'PUT', 'PATCH'] as const) {
      const r = await h.app.inject({ method, url: '/v1/files/file-1', headers: { authorization: `Bearer ${GW_UP}` } });
      expect(r.statusCode).toBe(200);
      expect(provider.seen.at(-1)).toMatchObject({ method, url: '/v1/files/file-1' });
    }

    // Over a real socket: inject() would resolve the dot segments itself.
    const forwarded = provider.seen.length;
    const address = new URL(await h.app.listen({ host: '127.0.0.1', port: 0 }));
    for (const path of [
      '/v1/files/%2e%2e/admin',
      '/v1/files/../admin',
      '/v1/files/%2E/x',
      '/v1/files/..%2fadmin',
      '/v1/files/%5c..%5cadmin',
      '/v1/files/%2F%2Fevil.example',
      '/v1/files/%zz',
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        http
          .request({ host: address.hostname, port: address.port, path, headers: { authorization: `Bearer ${GW_UP}` } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject)
          .end();
      });
      expect(status, path).toBe(400);
    }
    expect(provider.seen).toHaveLength(forwarded);
    // Other percent-encoding passes through verbatim.
    const encoded = await h.app.inject({ method: 'GET', url: '/v1/files/file%2D1%20x', headers: { authorization: `Bearer ${GW_UP}` } });
    expect(encoded.statusCode).toBe(200);
    expect(provider.seen.at(-1)?.url).toBe('/v1/files/file%2D1%20x');

    const strict = await harness({ settings: [['api_surface_source_openai', 'upstream']] });
    const unauthenticated = await strict.app.inject({ method: 'GET', url: '/v1/files' });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('streams uploads above the replay buffer once and caps them', async () => {
    const provider = await fakeProvider((seen, res) => {
      if (keyOf(seen) === KEY_A) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"a"}');
        return;
      }
      ok()(seen, res);
    });
    const h = await harness({ config: { replayBytes: 1024, maxUploadBytes: 4096 } });
    await h.addKey('openai', KEY_A, provider.base);
    await h.addKey('openai', KEY_B, provider.base);
    const post = (size: number) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/files',
        headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(size, 7),
      });

    const streamed = await post(2048);
    expect(streamed.statusCode).toBe(401);
    expect(streamed.payload).toBe('{"error":"a"}');
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]!.body.length).toBe(2048);

    const tooLarge = await post(8192);
    expect(tooLarge.statusCode).toBe(413);
    expect(JSON.parse(tooLarge.payload).error.code).toBe('payload_too_large');
  });

  it('streams server-sent events as they arrive and cuts the stream when the gateway key is revoked', async () => {
    let release!: () => void;
    const provider = await fakeProvider(async (_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      await new Promise<void>((resolve) => (release = resolve));
      res.write('data: 2\n\n');
      res.end('data: [DONE]\n\n');
    });
    const h = await harness();
    await h.addKey('openai', KEY_A, provider.base);
    const address = await h.app.listen({ host: '127.0.0.1', port: 0 });
    const open = () =>
      request(`${address}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${GW_UP}`, 'content-type': 'application/json' },
        body: '{"stream":true}',
      });

    const live = await open();
    expect(live.statusCode).toBe(200);
    expect(live.headers['content-type']).toBe('text/event-stream');
    const chunks = live.body[Symbol.asyncIterator]();
    expect(Buffer.from((await chunks.next()).value).toString()).toBe('data: 1\n\n');
    release();
    let rest = '';
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) rest += Buffer.from(next.value).toString();
    expect(rest).toBe('data: 2\n\ndata: [DONE]\n\n');

    const revoked = await open();
    const cut = revoked.body[Symbol.asyncIterator]();
    expect(Buffer.from((await cut.next()).value).toString()).toBe('data: 1\n\n');
    await h.gatewayKeys.setActive(2, false, 'codex');
    release();
    let after = '';
    await expect(
      (async () => {
        for (let next = await cut.next(); !next.done; next = await cut.next()) after += Buffer.from(next.value).toString();
      })(),
    ).rejects.toThrow();
    expect(after).not.toContain('data: 2');
  });

  it('forwards the Anthropic wire with x-api-key and a default anthropic-version', async () => {
    const provider = await fakeProvider((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_ant_up', 'anthropic-ratelimit-tokens-remaining': '5' });
      res.end('{"type":"message"}');
    });
    const h = await harness();
    await h.addKey('anthropic', 'sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC', provider.base);
    const r = await h.app.inject({
      method: 'POST',
      url: '/anthropic/v1/messages',
      headers: { 'x-api-key': GW_ANT, 'content-type': 'application/json', 'anthropic-beta': 'files-api-2025-04-14' },
      payload: '{"model":"claude-x","max_tokens":1,"messages":[]}',
    });
    expect(r.statusCode).toBe(200);
    expect(r.payload).toBe('{"type":"message"}');
    expect(r.headers['request-id']).toBe('req_ant_up');
    expect(r.headers['anthropic-ratelimit-tokens-remaining']).toBe('5');
    const seen = provider.seen[0]!;
    expect(seen.url).toBe('/v1/messages');
    expect(seen.headers['x-api-key']).toBe('sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCC');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.headers['anthropic-beta']).toBe('files-api-2025-04-14');
    expect(seen.headers.authorization).toBeUndefined();

    const files = await h.app.inject({ method: 'GET', url: '/anthropic/v1/files', headers: { 'x-api-key': GW_ANT } });
    expect(files.statusCode).toBe(200);
    expect(provider.seen.at(-1)?.url).toBe('/v1/files');
  });

  it('forwards the Grok and Kimi surfaces to xAI and Moonshot with their own keys', async () => {
    const provider = await fakeProvider(ok());
    const h = await harness();
    await h.addKey('xai', 'xai-DDDDDDDDDDDDDDDDDDDDDDDDDDDD', provider.base);
    await h.addKey('moonshot', 'sk-EEEEEEEEEEEEEEEEEEEEEEEEEEEE', provider.base);
    for (const [url, key, provider_key] of [
      ['/grok/v1/chat/completions', GW_GROK, 'xai-DDDDDDDDDDDDDDDDDDDDDDDDDDDD'],
      ['/kimi/v1/chat/completions', GW_KIMI, 'sk-EEEEEEEEEEEEEEEEEEEEEEEEEEEE'],
    ] as const) {
      const r = await h.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        payload: '{"model":"m","stream":true}',
      });
      expect(r.statusCode).toBe(200);
      expect(provider.seen.at(-1)).toMatchObject({ url: '/v1/chat/completions' });
      expect(keyOf(provider.seen.at(-1)!)).toBe(provider_key);
    }
  });
});
