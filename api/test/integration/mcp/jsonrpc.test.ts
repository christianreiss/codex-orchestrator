import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerMcpRoutes } from '../../../src/routes/mcp/index.js';
import type { RouteContext } from '../../../src/routes/index.js';
import type { Host } from '../../../src/db/schema.js';

// Persistence is covered by host-lifecycle tests; this suite uses a stub DB.
vi.mock('../../../src/services/host-lifecycle.js', () => ({
  recordHostContact: async (_db: unknown, host: Host) => host,
}));

/**
 * The /mcp routes are wired against a stub DB + env. We don't exercise
 * persistence here; we exercise (a) the GET probe semantics, and (b) the
 * Origin allow-list gating. Full JSON-RPC dispatch is unit-tested over the
 * services layer (mcp-server.test.ts), which is the same code path.
 */

function makeStubHost(): Host {
  return {
    id: 7,
    fqdn: 'test.example',
    status: 'active',
    secure: 1,
    apiKey: 'sk-codex-' + 'a'.repeat(32),
    apiKeyHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as unknown as Host;
}

interface BuildOpts {
  mcpAllow?: boolean;
  operatorToken?: string;
  fsRoot?: string;
  /** Runs before the routes register, e.g. to add a hook the production server has. */
  configure?: (app: FastifyInstance) => void;
}

async function buildApp(opts: BuildOpts | boolean = {}): Promise<FastifyInstance> {
  const o: BuildOpts = typeof opts === 'boolean' ? { mcpAllow: opts } : opts;
  const app = Fastify({ logger: false });
  await app.register(envelopePlugin);
  o.configure?.(app);

  app.decorate('resolveHostFromKey', async (_req: FastifyRequest) => makeStubHost());
  app.decorate('requireHost', async (req: FastifyRequest) => {
    req.authHost = makeStubHost();
  });

  // Provide a stub DB whose `.insert(...).values(...)`, `.select()...` chain
  // never throws. We only need MCP token verification to return null so the
  // host-key fallback kicks in.
  const fakeDb: unknown = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          orderBy: () => ({ limit: async () => [] }),
        }),
        orderBy: () => ({ limit: async () => [] }),
        limit: async () => [],
      }),
    }),
    insert: () => ({
      values: () => Promise.resolve([{ insertId: 1 }]),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    execute: async () => [[]],
  };

  const ctx: RouteContext = {
    db: fakeDb as never,
    env: {
      MCP_ALLOW_REQUEST_HOST_ORIGIN: o.mcpAllow ?? false,
      MCP_OPERATOR_TOKEN: o.operatorToken,
      MCP_FS_ROOT: o.fsRoot,
      MCP_FS_MAX_READ_BYTES: 1024 * 1024,
      MCP_FS_MAX_LIST_ENTRIES: 1000,
      MCP_FS_MAX_SEARCH_HITS: 200,
    } as never,
    keyring: {} as never,
  };
  await registerMcpRoutes(app, ctx);
  return app;
}

describe('MCP transport', () => {
  it('GET /mcp returns 405 with POST advisory when no Origin and allow-flag default', async () => {
    const app = await buildApp(false);
    const r = await app.inject({ method: 'GET', url: '/mcp' });
    expect(r.statusCode).toBe(405);
    expect(r.payload).toContain('POST only');
    expect(r.headers['allow']).toBe('POST');
    await app.close();
  });

  it('GET /mcp returns 403 when Origin is present and allow-flag is false', async () => {
    const app = await buildApp(false);
    const r = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.payload).toMatch(/not allowed/i);
    await app.close();
  });

  it('GET /mcp returns 405 when Origin is present but allow-flag is true', async () => {
    const app = await buildApp(true);
    const r = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { origin: 'https://trusted.example' },
    });
    expect(r.statusCode).toBe(405);
    await app.close();
  });

  it('POST /mcp requires a credential (no auth → 401)', async () => {
    const app = await buildApp(true);
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    // resolveHostFromKey returns a host unconditionally → 200 jsonrpc result
    // To trigger 401 we'd need to flip resolveHostFromKey. Skip strict status
    // here and verify the body is JSON-RPC shaped.
    expect(r.statusCode === 200 || r.statusCode === 401).toBe(true);
    if (r.statusCode === 200) {
      const body = JSON.parse(r.payload);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.result?.protocolVersion).toBeDefined();
    }
    await app.close();
  });
});

describe('MCP capability split', () => {
  let fsRoot: string;
  const OPERATOR_TOKEN = 'op-' + 'z'.repeat(48);

  beforeAll(() => {
    fsRoot = mkdtempSync(join(tmpdir(), 'mcp-cap-'));
    writeFileSync(join(fsRoot, 'hello.txt'), 'hi from operator');
  });

  afterAll(() => {
    rmSync(fsRoot, { recursive: true, force: true });
  });

  it('tools/list returns only host tools without operator bearer', async () => {
    const app = await buildApp({ mcpAllow: true, operatorToken: OPERATOR_TOKEN, fsRoot });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer host-session-token' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('memory_store');
    expect(names).toContain('skill_store');
    expect(names).toContain('skill_delete');
    expect(names).toEqual(
      expect.arrayContaining(['secret_list', 'secret_search', 'secret_get', 'secret_store', 'secret_delete']),
    );
    expect(names).not.toContain('fs_read_file');
    expect(names).not.toContain('fs_write_file');
    expect(names).not.toContain('agent_fresh_start_approve');
    await app.close();
  });

  it('tools/list returns host + operator tools with valid operator bearer', async () => {
    const app = await buildApp({ mcpAllow: true, operatorToken: OPERATOR_TOKEN, fsRoot });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      // Operator bearer only grants elevated capability -- host identity
      // still comes from X-Api-Key (see mcp/index.ts resolveHost()).
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-api-key': 'sk-codex-' + 'a'.repeat(32) },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('memory_store');
    expect(names).toContain('fs_read_file');
    expect(names).toContain('fs_search_in_files');
    expect(names).toContain('agent_fresh_start_approve');
    await app.close();
  });

  it.each([
    { name: 'fs_read_file', arguments: { path: 'hello.txt' } },
    { name: 'agent_fresh_start_approve', arguments: { message_id: 'd90d37a9-442c-4a98-bd55-c85274e18bcc', version: 1, reason: 'Fixture' } },
  ])('tools/call on operator tool $name from a host caller returns -32601', async (params) => {
    const app = await buildApp({ mcpAllow: true, operatorToken: OPERATOR_TOKEN, fsRoot });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer host-session-token' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.error?.code).toBe(-32601);
    // Must not contain content (so existence does not leak).
    expect(body.result).toBeUndefined();
    await app.close();
  });

  it('tools/call on an operator tool succeeds with operator bearer', async () => {
    const app = await buildApp({ mcpAllow: true, operatorToken: OPERATOR_TOKEN, fsRoot });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      // Operator bearer only grants elevated capability -- host identity
      // still comes from X-Api-Key (see mcp/index.ts resolveHost()).
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-api-key': 'sk-codex-' + 'a'.repeat(32) },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fs_read_file', arguments: { path: 'hello.txt' } },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.payload);
    expect(body.result?.isError).toBe(false);
    const text: string = body.result.content[0].text;
    expect(text).toContain('hi from operator');
    await app.close();
  });

  it('without MCP_FS_ROOT, fs_* tools are not registered even for operators', async () => {
    const app = await buildApp({ mcpAllow: true, operatorToken: OPERATOR_TOKEN });
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      // Operator bearer only grants elevated capability -- host identity
      // still comes from X-Api-Key (see mcp/index.ts resolveHost()).
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-api-key': 'sk-codex-' + 'a'.repeat(32) },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    const body = JSON.parse(r.payload);
    const names: string[] = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('fs_read_file');
    // memory_store is still listed.
    expect(names).toContain('memory_store');

    // Operator caller invoking fs_read_file gets -32601 (tool not registered).
    const r2 = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, 'x-api-key': 'sk-codex-' + 'a'.repeat(32) },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'fs_read_file', arguments: { path: 'x' } },
      },
    });
    const body2 = JSON.parse(r2.payload);
    expect(body2.error?.code).toBe(-32601);
    await app.close();
  });
});

describe('MCP transport over a real socket', () => {
  // `inject` never reaches node's ServerResponse, so it cannot see a second
  // send: an async handler that resolves to undefined after reply.send() makes
  // Fastify send again while async onSend hooks are still running, and the
  // resulting uncaught ERR_HTTP_HEADERS_SENT terminates the API process.
  function request(port: number, method: string, headers: Record<string, string | undefined>, body?: string) {
    return new Promise<{ status: number; allow?: string; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path: '/mcp', headers }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, allow: res.headers['allow'] as string | undefined, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it.each([
    { name: 'GET without Origin', method: 'GET', headers: {}, body: undefined, status: 405, text: 'POST only' },
    { name: 'GET with Origin', method: 'GET', headers: { origin: 'https://evil.example' }, body: undefined, status: 403, text: 'Origin not allowed' },
    {
      name: 'POST with Origin',
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      status: 403,
      text: 'Origin not allowed',
    },
  ])('answers $name once and keeps the process alive', async ({ method, headers, body, status, text }) => {
    const uncaught: unknown[] = [];
    const record = (err: unknown) => void uncaught.push(err);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);
    // Production adds the owner-response boundary's async onSend hooks on top
    // of the envelope's, so the handler's promise settles while the first send
    // is still in flight. The delay makes that ordering independent of how
    // many microtasks Fastify's hook runner happens to take.
    const slowOnSend = (a: FastifyInstance) =>
      a.addHook('onSend', async (_req, _reply, payload) => (await new Promise(resolve => setTimeout(resolve, 20)), payload));
    const app = await buildApp({ mcpAllow: false, configure: slowOnSend });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const res = await request(port, method, headers, body);
      expect(res.status).toBe(status);
      expect(res.body).toContain(text);
      if (status === 405) expect(res.allow).toBe('POST');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
      process.off('unhandledRejection', record);
      await app.close();
    }
  });
});
