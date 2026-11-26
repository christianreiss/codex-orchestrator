import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, request } from 'undici';
import {
  createGuardedConnector,
  createGuardedLookup,
  isBlockedAddress,
  ownHostsFrom,
  parseBaseUrl,
  parseHostList,
  type UpstreamNetworkPolicy,
} from '../../../src/services/gateway-upstream/base-url.js';
import { clientResponseHeaders, upstreamRequestHeaders } from '../../../src/services/gateway-upstream/headers.js';
import {
  KeyCooldowns,
  classifyStatus,
  orderCandidates,
  retryAfterSeconds,
} from '../../../src/services/gateway-upstream/failover.js';
import { describeReason, safeReason } from '../../../src/services/gateway-upstream/telemetry.js';
import { classifyVerification, verifyProviderKey } from '../../../src/services/gateway-upstream/verify.js';
import { createUpstreamAgent, upstreamConfigFromEnv } from '../../../src/services/gateway-upstream/client.js';
import { keyHint } from '../../../src/services/provider-api-keys.js';

const NONE: UpstreamNetworkPolicy = { privateHosts: new Set(), ownHosts: new Set() };

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::1',
    '2001::1',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '104.18.6.192', '2606:4700::6810:84e5', '2a00:1450:4001:80b::200e', '64:ff9b::808:808'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('parseBaseUrl', () => {
  const policy: UpstreamNetworkPolicy = {
    privateHosts: parseHostList('proxy.internal, 127.0.0.1'),
    ownHosts: ownHostsFrom('https://orchestrator.example.org'),
  };

  it('canonicalises an https URL and drops a trailing slash', () => {
    expect(parseBaseUrl('https://API.Example.com/openai/v1/', policy)).toBe('https://api.example.com/openai/v1');
    expect(parseBaseUrl('https://example.com:8443', policy)).toBe('https://example.com:8443');
  });

  it.each([
    ['http://api.example.com/v1', 'https'],
    ['ftp://api.example.com/v1', 'https'],
    ['https://user:pass@api.example.com/v1', 'credentials'],
    ['https://sk-secret@api.example.com/v1', 'credentials'],
    ['https://api.example.com/v1?x=1', 'query'],
    ['https://api.example.com/v1#frag', 'fragment'],
    ['https://orchestrator.example.org/v1', 'this orchestrator'],
    // 127.0.0.1 itself is a listed private host here; these spell 127.0.0.2.
    ['https://127.2/v1', 'private'],
    ['https://2130706434/v1', 'private'],
    ['https://0x7f000002/v1', 'private'],
    ['https://0177.0.0.2/v1', 'private'],
    ['https://[::1]/v1', 'private'],
    ['https://[::ffff:127.0.0.1]/v1', 'private'],
    ['https://169.254.169.254/latest', 'private'],
    ['https://10.0.0.5/v1', 'private'],
    ['https://localhost/v1', 'private'],
    ['https://foo.localhost/v1', 'private'],
    ['https://api.example.com/v1 x', 'whitespace'],
    ['not a url', 'whitespace'],
    ['/relative', 'absolute'],
    [`https://example.com/${'a'.repeat(520)}`, '512'],
    ['', 'empty'],
  ])('refuses %s', (value, fragment) => {
    expect(() => parseBaseUrl(value, policy)).toThrow(fragment);
  });

  it('never echoes the submitted URL in its error', () => {
    try {
      parseBaseUrl('https://sk-live-secretvalue:x@api.example.com/v1', policy);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secretvalue');
    }
  });

  it('allows plain http and a private address only for listed private hosts', () => {
    expect(parseBaseUrl('http://proxy.internal:8080/v1', policy)).toBe('http://proxy.internal:8080/v1');
    expect(parseBaseUrl('http://127.0.0.1:9000/v1', policy)).toBe('http://127.0.0.1:9000/v1');
    expect(() => parseBaseUrl('http://127.0.0.2:9000/v1', policy)).toThrow('https');
  });
});

describe('createGuardedLookup', () => {
  const resolveTo = (addresses: LookupAddress[]) => (_host: string, _opts: unknown, cb: (err: null, a: LookupAddress[]) => void) =>
    cb(null, addresses);

  function run(policy: UpstreamNetworkPolicy, addresses: LookupAddress[], all: boolean) {
    return new Promise<{ err: unknown; address: unknown; family?: number }>((resolve) =>
      createGuardedLookup(policy, resolveTo(addresses) as never)('upstream.test', { all }, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );
  }

  it('refuses a name when any resolved address is private (DNS rebinding)', async () => {
    const out = await run(NONE, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], true);
    expect((out.err as { code?: string }).code).toBe('EGATEWAYBLOCKED');
  });

  it('refuses a name that resolves to an IPv4-mapped loopback', async () => {
    const out = await run(NONE, [{ address: '::ffff:127.0.0.1', family: 6 }], false);
    expect((out.err as { code?: string }).code).toBe('EGATEWAYBLOCKED');
  });

  it('answers in the shape the caller asked for', async () => {
    const all = await run(NONE, [{ address: '93.184.216.34', family: 4 }], true);
    expect(all).toEqual({ err: null, address: [{ address: '93.184.216.34', family: 4 }], family: undefined });
    const one = await run(NONE, [{ address: '93.184.216.34', family: 4 }], false);
    expect(one).toEqual({ err: null, address: '93.184.216.34', family: 4 });
  });

  it('exempts a listed private host', async () => {
    const out = await run({ privateHosts: new Set(['upstream.test']), ownHosts: new Set() }, [{ address: '127.0.0.1', family: 4 }], false);
    expect(out.err).toBeNull();
  });
});

describe('guarded connector', () => {
  let server: Server | undefined;
  const agents: Agent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function listen(): Promise<number> {
    server = createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function agentFor(policy: UpstreamNetworkPolicy, resolve?: never) {
    const agent = new Agent({ connect: createGuardedConnector(policy, { connectTimeoutMs: 2000, resolve }) });
    agents.push(agent);
    return agent;
  }

  it('refuses a loopback IP literal unless it is a listed private host', async () => {
    const port = await listen();
    await expect(request(`http://127.0.0.1:${port}/`, { dispatcher: agentFor(NONE) })).rejects.toMatchObject({ code: 'EGATEWAYBLOCKED' });
    const ok = await request(`http://127.0.0.1:${port}/`, {
      dispatcher: agentFor({ privateHosts: new Set(['127.0.0.1']), ownHosts: new Set() }),
    });
    expect(await ok.body.text()).toBe('reached');
  });

  it('refuses plain http to a public host', async () => {
    await expect(request('http://93.184.216.34:1/', { dispatcher: agentFor(NONE) })).rejects.toMatchObject({ code: 'EGATEWAYBLOCKED' });
  });

  it('refuses a name that resolves to loopback before connecting', async () => {
    const port = await listen();
    const resolve = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    // https so the protocol rule does not decide it: the address check must.
    await expect(request(`https://rebind.test:${port}/`, { dispatcher: agentFor(NONE, resolve) })).rejects.toMatchObject({
      code: 'EGATEWAYBLOCKED',
    });
  });
});

describe('header policy', () => {
  it('forwards SDK request headers and replaces the client credential', () => {
    const out = upstreamRequestHeaders(
      {
        authorization: 'Bearer sk-cdx-client',
        'x-api-key': 'client-key',
        cookie: 'session=1',
        'openai-organization': 'org-other',
        'openai-project': 'proj-other',
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'accept-encoding': 'gzip',
        'user-agent': 'OpenAI/Python 1.0',
        'idempotency-key': 'abc',
        'x-stainless-retry-count': '0',
        'openai-beta': 'assistants=v2',
        'anthropic-beta': 'x',
        'x-forwarded-for': '1.2.3.4',
        host: 'orchestrator.example.org',
        connection: 'keep-alive',
        'content-length': '12',
      },
      'openai',
      'sk-upstream',
    );
    expect(out).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'accept-encoding': 'gzip',
      'user-agent': 'OpenAI/Python 1.0',
      'idempotency-key': 'abc',
      'x-stainless-retry-count': '0',
      'openai-beta': 'assistants=v2',
      authorization: 'Bearer sk-upstream',
    });
  });

  it('uses x-api-key and a default anthropic-version for Anthropic', () => {
    const out = upstreamRequestHeaders({ authorization: 'Bearer client', 'anthropic-beta': 'tools-2024' }, 'anthropic', 'sk-ant-api03-up', {
      contentLength: 10,
    });
    expect(out).toEqual({
      'anthropic-beta': 'tools-2024',
      'anthropic-version': '2023-06-01',
      'content-length': '10',
      'x-api-key': 'sk-ant-api03-up',
    });
    expect(out.authorization).toBeUndefined();
  });

  it('keeps our CORS headers, strips account headers and replaces the request id', () => {
    const out = clientResponseHeaders(
      {
        'content-type': 'text/event-stream',
        'x-request-id': 'req_upstream',
        'openai-organization': 'org-ours',
        'openai-project': 'proj-ours',
        'set-cookie': ['__cf_bm=1'],
        server: 'cloudflare',
        'cf-ray': 'abc',
        'x-ratelimit-remaining-requests': '99',
        'anthropic-ratelimit-tokens-remaining': '5',
        'retry-after': '3',
        'transfer-encoding': 'chunked',
      },
      { 'access-control-allow-origin': '*', 'x-request-id': 'ours-1', 'content-type': 'application/json' },
      'ours-1',
    );
    expect(out).toEqual({
      'access-control-allow-origin': '*',
      'content-type': 'text/event-stream',
      'x-request-id': 'req_upstream',
      'x-ratelimit-remaining-requests': '99',
      'anthropic-ratelimit-tokens-remaining': '5',
      'retry-after': '3',
      'x-gateway-request-id': 'ours-1',
    });
  });
});

describe('failover policy', () => {
  it('classifies only key-specific statuses as failover', () => {
    expect([401, 403, 429, 400, 404, 500, 529, 200].map(classifyStatus)).toEqual([
      'unauthorized',
      'forbidden',
      'rate_limited',
      'commit',
      'commit',
      'commit',
      'commit',
      'commit',
    ]);
  });

  it('clamps retry-after to 1-300 s with a 30 s default', () => {
    expect(retryAfterSeconds({})).toBe(30);
    expect(retryAfterSeconds({ 'retry-after': '0' })).toBe(1);
    expect(retryAfterSeconds({ 'retry-after': '12' })).toBe(12);
    expect(retryAfterSeconds({ 'retry-after': '86400' })).toBe(300);
    expect(retryAfterSeconds({ 'retry-after-ms': '1500' })).toBe(2);
    expect(retryAfterSeconds({ 'retry-after': 'garbage' })).toBe(30);
    const now = Date.parse('2026-11-26T12:00:00Z');
    expect(retryAfterSeconds({ 'retry-after': 'Thu, 26 Nov 2026 12:00:45 GMT' }, now)).toBe(45);
  });

  it('orders by sort_order and id and moves cooling keys to the end', () => {
    const cooldowns = new KeyCooldowns();
    const now = 1_000_000;
    const keys = [
      { id: 3, sortOrder: 1 },
      { id: 1, sortOrder: 0 },
      { id: 2, sortOrder: 0 },
      { id: 4, sortOrder: 2 },
    ];
    expect(orderCandidates(keys, cooldowns, now).map((k) => k.id)).toEqual([1, 2, 3, 4]);
    cooldowns.set(1, 60, now);
    cooldowns.set(2, 30, now);
    expect(orderCandidates(keys, cooldowns, now).map((k) => k.id)).toEqual([3, 4, 2, 1]);
    expect(orderCandidates(keys, cooldowns, now + 61_000).map((k) => k.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('reason vocabulary', () => {
  it('redacts key-like tokens and caps at 255 characters', () => {
    expect(safeReason('failed for sk-proj-abcdefghijklmnop and xai-ABCDEFGHIJ')).toBe('failed for [redacted] and [redacted]');
    expect(safeReason('x'.repeat(10) + ' ' + 'y '.repeat(300)).length).toBe(255);
    expect(describeReason('unauthorized', 401)).toBe('unauthorized (HTTP 401)');
    expect(describeReason('unreachable')).toBe('unreachable');
  });
});

describe('keyHint', () => {
  it('keeps the type prefix and the last four characters', () => {
    expect(keyHint('sk-proj-abcdefghijklmnopqrstuvwx1234')).toBe('sk-proj-…1234');
    expect(keyHint('sk-ant-api03-abcdefghijklmnop9876')).toBe('sk-ant-…9876');
    expect(keyHint('xai-abcdefghijklmnopqrstu5678')).toBe('xai-…5678');
    expect(keyHint('abcdefghijklmnopqrst4321')).toBe('…4321');
  });
});

describe('verifyProviderKey', () => {
  let server: Server | undefined;
  let agent: Agent | undefined;
  afterEach(async () => {
    await agent?.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = agent = undefined;
  });

  async function upstream(status: number, seen: Array<Record<string, unknown>>): Promise<string> {
    server = createServer((req, res) => {
      seen.push({ path: req.url, ...req.headers });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'leaked body sk-should-never-appear-anywhere' } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    agent = createUpstreamAgent(upstreamConfigFromEnv({ GATEWAY_UPSTREAM_PRIVATE_HOSTS: '127.0.0.1' } as never));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  it.each([
    [200, 'valid', 'ok (HTTP 200)'],
    [401, 'invalid', 'unauthorized (HTTP 401)'],
    [403, 'invalid', 'forbidden (HTTP 403)'],
    [429, 'error', 'rate_limited (HTTP 429)'],
    [500, 'error', 'upstream_error (HTTP 500)'],
  ])('maps HTTP %i to %s without echoing the body', async (status, state, reason) => {
    const seen: Array<Record<string, unknown>> = [];
    const base = await upstream(status, seen);
    const result = await verifyProviderKey(agent!, 'anthropic', base, 'sk-ant-api03-verifyme');
    expect(result).toEqual({ state, reason, status });
    expect(JSON.stringify(result)).not.toContain('should-never-appear');
    expect(seen[0]).toMatchObject({ path: '/v1/models', 'x-api-key': 'sk-ant-api03-verifyme', 'anthropic-version': '2023-06-01' });
  });

  it('keeps a key that authenticated but lacks a scope, and reads xAI\'s 400 for a wrong key', () => {
    const restricted = classifyVerification(
      'openai',
      401,
      JSON.stringify({ error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } }),
    );
    expect(restricted).toEqual({ state: 'valid', reason: 'restricted (HTTP 401)', status: 401 });
    expect(
      classifyVerification('anthropic', 403, '{"type":"error","error":{"type":"permission_error","message":"no access"}}'),
    ).toEqual({ state: 'valid', reason: 'restricted (HTTP 403)', status: 403 });
    expect(classifyVerification('openai', 401, '{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}')).toEqual({
      state: 'invalid',
      reason: 'unauthorized (HTTP 401)',
      status: 401,
    });
    expect(classifyVerification('xai', 400, '{"error":"Incorrect API key provided: xa***"}')).toEqual({
      state: 'invalid',
      reason: 'unauthorized (HTTP 400)',
      status: 400,
    });
    expect(classifyVerification('openai', 400, '{"error":"Incorrect API key provided"}').state).toBe('error');
    expect(classifyVerification('xai', 400, '{"error":"bad request"}').state).toBe('error');
  });

  it('classifies a real error answer from its first bytes only', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.write('{"error":{"message":"Missing scopes: api.model.read"},"pad":"');
      res.end(`${'x'.repeat(64 * 1024)}"}`);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    agent = createUpstreamAgent(upstreamConfigFromEnv({ GATEWAY_UPSTREAM_PRIVATE_HOSTS: '127.0.0.1' } as never));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    expect(await verifyProviderKey(agent, 'openai', base, 'sk-proj-verifyme1234')).toEqual({
      state: 'valid',
      reason: 'restricted (HTTP 401)',
      status: 401,
    });
  });

  it('uses the guarded agent: a loopback base is refused when not a private host', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const base = await upstream(200, seen);
    const guarded = createUpstreamAgent(upstreamConfigFromEnv({} as never));
    try {
      const result = await verifyProviderKey(guarded, 'openai', base, 'sk-proj-verifyme1234');
      expect(result).toEqual({ state: 'error', reason: 'blocked_address', status: null });
      expect(seen).toHaveLength(0);
    } finally {
      await guarded.close();
    }
  });
});
