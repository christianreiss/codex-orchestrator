import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerMcpRoutes } from '../../../src/routes/mcp/index.js';
import { McpSessionService } from '../../../src/services/mcp-session.js';
import { McpServer, type DispatchContext } from '../../../src/services/mcp-server.js';
import { extractApiKey } from '../../../src/util/api-key-helpers.js';
import type { RouteContext } from '../../../src/routes/index.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * Credential resolution for POST /mcp (resolveHost() in routes/mcp/index.ts).
 * jsonrpc.test.ts stubs resolveHostFromKey to hand back a host for every
 * request, so none of these branches are observable there. Here the stub
 * records the headers it was asked to resolve, McpSessionService.verify()
 * accepts a known token only, and McpServer.handlePayload() is stubbed so the
 * dispatch context (host, capability, engine) can be asserted directly.
 */

const OPERATOR_TOKEN = 'op-' + 'z'.repeat(48);
const SESSION_TOKEN = 'mcp-session-' + 'b'.repeat(40);
const HOST_KEY = 'sk-codex-' + 'a'.repeat(32);

type Headers = Record<string, string | string[] | undefined>;

function makeHost(fqdn: string, status = 'active'): Host {
  return {
    id: 7,
    fqdn,
    status,
    secure: 1,
    apiKey: HOST_KEY,
    apiKeyHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as Host;
}

interface HarnessOpts {
  operatorToken?: string;
  /** Tokens McpSessionService.verify() accepts, mapped to their host. */
  sessions?: Record<string, Host>;
  /** Host returned by resolveHostFromKey; defaults to one named after the key. */
  hostFromKey?: Host;
}

interface Harness {
  app: FastifyInstance;
  /** Headers handed to app.resolveHostFromKey(), one entry per call. */
  lookups: Headers[];
  /** Tokens handed to McpSessionService.verify(), one entry per call. */
  verified: string[];
  /** Dispatch contexts handed to McpServer.handlePayload(). */
  contexts: DispatchContext[];
}

async function buildHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const lookups: Headers[] = [];
  const verified: string[] = [];
  const contexts: DispatchContext[] = [];

  vi.spyOn(McpSessionService.prototype, 'verify').mockImplementation(async (token: string) => {
    verified.push(token);
    return opts.sessions?.[token] ?? null;
  });
  vi.spyOn(McpServer.prototype, 'handlePayload').mockImplementation(async (_body, ctx) => {
    contexts.push(ctx);
    return { jsonrpc: '2.0' as const, id: 1, result: {} };
  });

  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  app.decorate('resolveHostFromKey', async (req: FastifyRequest): Promise<Host | null> => {
    const headers = req.headers as Headers;
    lookups.push(headers);
    const key = extractApiKey(headers);
    if (!key) return null;
    return opts.hostFromKey ?? makeHost(`${key}.example`);
  });

  const ctx: RouteContext = {
    // Both DB-backed paths (session verify, access logging) are stubbed out.
    db: {} as never,
    env: {
      MCP_ALLOW_REQUEST_HOST_ORIGIN: true,
      MCP_OPERATOR_TOKEN: opts.operatorToken,
    } as never,
    keyring: {} as never,
  };
  await registerMcpRoutes(app, ctx);
  return { app, lookups, verified, contexts };
}

function post(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
}

const fallthroughBearers: Array<[string, string]> = [
  ['a bearer that is not the operator token', 'op-' + 'y'.repeat(48)],
  ['an operator token of the wrong length', OPERATOR_TOKEN.slice(0, -1)],
];

const engineHeaders: Array<[string | undefined, string | null]> = [
  ['codex', 'codex'],
  ['claude', 'claude'],
  ['gemini', null],
  [undefined, null],
];

describe('POST /mcp credential resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes host identity from X-Api-Key alone when the bearer is the operator token', async () => {
    const h = await buildHarness({ operatorToken: OPERATOR_TOKEN });
    const r = await post(h.app, { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-api-key': HOST_KEY });

    expect(r.statusCode).toBe(200);
    // The operator token identifies an operator, never a host: only the
    // X-Api-Key value may reach the session lookup or the key lookup.
    expect(h.verified).toEqual([HOST_KEY]);
    expect(h.lookups).toHaveLength(1);
    const headers = h.lookups[0] ?? {};
    expect(headers['authorization']).toBeUndefined();
    expect(extractApiKey(headers)).toBe(HOST_KEY);
    expect(h.contexts[0]?.host.fqdn).toBe(`${HOST_KEY}.example`);
    expect(h.contexts[0]?.capability).toBe('operator');
    await h.app.close();
  });

  it('401s with invalid_mcp_credential when the operator bearer comes without X-Api-Key', async () => {
    const h = await buildHarness({ operatorToken: OPERATOR_TOKEN });
    const r = await post(h.app, { authorization: `Bearer ${OPERATOR_TOKEN}` });

    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.payload).code).toBe('invalid_mcp_credential');
    expect(h.verified).toEqual([]);
    expect(h.lookups).toEqual([]);
    expect(h.contexts).toEqual([]);
    await h.app.close();
  });

  it('resolves an mcp-session bearer without falling through to the key lookup', async () => {
    const h = await buildHarness({
      operatorToken: OPERATOR_TOKEN,
      sessions: { [SESSION_TOKEN]: makeHost('session.example') },
    });
    const r = await post(h.app, { authorization: `Bearer ${SESSION_TOKEN}` });

    expect(r.statusCode).toBe(200);
    expect(h.verified).toEqual([SESSION_TOKEN]);
    expect(h.lookups).toEqual([]);
    expect(h.contexts[0]?.host.fqdn).toBe('session.example');
    await h.app.close();
  });

  it.each(fallthroughBearers)('falls through to extractApiKey with capability host for %s', async (_name, bearer) => {
    const h = await buildHarness({ operatorToken: OPERATOR_TOKEN });
    const r = await post(h.app, { authorization: `Bearer ${bearer}`, 'x-api-key': HOST_KEY });

    expect(r.statusCode).toBe(200);
    // extractApiKey() prefers Authorization over X-Api-Key, so the bearer --
    // not HOST_KEY -- is what identifies the host on this path.
    expect(h.verified).toEqual([bearer]);
    expect(h.lookups[0]?.['authorization']).toBe(`Bearer ${bearer}`);
    expect(h.contexts[0]?.host.fqdn).toBe(`${bearer}.example`);
    expect(h.contexts[0]?.capability).toBe('host');
    await h.app.close();
  });

  it.each(['disabled', 'pending'])('403s with host_%s when the resolved host is not active', async (status) => {
    const h = await buildHarness({ hostFromKey: makeHost('inactive.example', status) });
    const r = await post(h.app, { 'x-api-key': HOST_KEY });

    // Deliberately 403 here, where requireHost() answers 401 for the same host
    // state (http/plugins/auth-host.ts).
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload).code).toBe(`host_${status}`);
    expect(h.contexts).toEqual([]);
    await h.app.close();
  });

  it.each(engineHeaders)('dispatches x-engine %s as engine %s', async (header, expected) => {
    const h = await buildHarness();
    const headers: Record<string, string> = { 'x-api-key': HOST_KEY };
    if (header !== undefined) headers['x-engine'] = header;
    const r = await post(h.app, headers);

    expect(r.statusCode).toBe(200);
    expect(h.contexts[0]?.engine).toBe(expected);
    await h.app.close();
  });
});
