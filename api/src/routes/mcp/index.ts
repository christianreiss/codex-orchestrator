/**
 * MCP transport routes.
 *
 * GET /mcp — probe. Returns 405 with body `"POST only, JSON-RPC 2.0"`.
 * When `MCP_ALLOW_REQUEST_HOST_ORIGIN=false` (default), any browser-style
 * request that supplies an Origin header is rejected with 403 (the allow
 * list is empty by default).
 *
 * POST /mcp — JSON-RPC 2.0 dispatcher. Accepts an mcp-session token in
 * Authorization: Bearer, falling back to a host API key for compatibility
 * with cdx/clx clients that go straight from auth to MCP.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { RouteContext } from '../index.js';
import { raw } from '../../http/reply.js';
import { ForbiddenError, UnauthorizedError } from '../../http/errors.js';
import { extractApiKey, parseBearer } from '../../util/api-key-helpers.js';
import { ENGINE_CODEX, isEngine } from '../../util/engine.js';

import { McpSessionService } from '../../services/mcp-session.js';
import { McpAccessLogService } from '../../services/mcp-access-log.js';
import { McpMemoriesService } from '../../services/mcp-memories.js';
import { SharedMemoriesService } from '../../services/shared-memories.js';
import { SecretsService } from '../../services/secrets.js';
import { HostProjectsService } from '../../services/host-projects.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { McpToolsRegistry, type Capability } from '../../services/mcp-tools.js';
import { McpFsTools } from '../../services/mcp-fs.js';
import { McpResourcesService } from '../../services/mcp-resources.js';
import { McpServer } from '../../services/mcp-server.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import type { Host } from '../../db/schema.js';

export async function registerMcpRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const sessions = new McpSessionService(ctx.db);
  const accessLog = new McpAccessLogService(ctx.db);
  const memories = new McpMemoriesService(ctx.db);
  const sharedMemories = new SharedMemoriesService(ctx.db);
  const projects = new HostProjectsService(ctx.db);
  const skills = new HostSkillsService(ctx.db);

  // fs_* tools are only registered when MCP_FS_ROOT points at an existing
  // directory. When unset (or invalid), the operator surface is empty.
  const fsRootRaw = (ctx.env as { MCP_FS_ROOT?: string }).MCP_FS_ROOT;
  let fsTools: McpFsTools | undefined;
  if (fsRootRaw && fsRootRaw.trim()) {
    const abs = resolvePath(fsRootRaw.trim());
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      fsTools = new McpFsTools({
        root: abs,
        maxReadBytes: Number((ctx.env as { MCP_FS_MAX_READ_BYTES?: number }).MCP_FS_MAX_READ_BYTES) || 1024 * 1024,
        maxListEntries: Number((ctx.env as { MCP_FS_MAX_LIST_ENTRIES?: number }).MCP_FS_MAX_LIST_ENTRIES) || 1000,
        maxSearchHits: Number((ctx.env as { MCP_FS_MAX_SEARCH_HITS?: number }).MCP_FS_MAX_SEARCH_HITS) || 200,
      });
    }
  }

  // The secrets service needs the access log: `secret_get` writes its own audit
  // row, carrying the slug and failing closed, rather than relying on the
  // generic tools/call row McpServer logs on a best-effort basis.
  const secrets = new SecretsService({ db: ctx.db, keyring: ctx.keyring, accessLog });

  const resources = new McpResourcesService({ memories, sharedMemories, projects, skills });
  const tools = new McpToolsRegistry({
    memories,
    sharedMemories,
    projects,
    skills,
    resources,
    fs: fsTools,
    secrets,
  });
  const server = new McpServer(tools, resources, accessLog);

  const operatorToken = ((ctx.env as { MCP_OPERATOR_TOKEN?: string }).MCP_OPERATOR_TOKEN ?? '').trim();

  async function resolveHost(req: FastifyRequest): Promise<Host | null> {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    // When the Authorization bearer is the operator token, it identifies the
    // caller as an operator, not a host — host identity must then come from
    // X-Api-Key alone, since extractApiKey() would otherwise return the
    // operator token itself (Authorization always wins over X-Api-Key there).
    const bearer = parseBearer(headers['authorization']);
    const isOperatorBearer =
      operatorToken.length > 0 &&
      bearer !== null &&
      bearer.length === operatorToken.length &&
      timingSafeEqual(Buffer.from(bearer), Buffer.from(operatorToken));
    let key: string | null;
    let hostLookupReq = req;
    if (isOperatorBearer) {
      const xk = headers['x-api-key'];
      key = typeof xk === 'string' && xk.trim() ? xk.trim() : Array.isArray(xk) && xk[0] ? xk[0].trim() : null;
      // app.resolveHostFromKey() re-derives the key from req.headers via
      // extractApiKey(), which would pick the operator bearer again; strip
      // Authorization so it falls through to X-Api-Key like we just did.
      hostLookupReq = { headers: { ...headers, authorization: undefined } } as FastifyRequest;
    } else {
      key = extractApiKey(headers);
    }
    if (!key) return null;
    const fromSession = await sessions.verify(key);
    if (fromSession) return fromSession;
    return app.resolveHostFromKey(hostLookupReq);
  }

  function detectCapability(req: FastifyRequest): Capability {
    if (!operatorToken) return 'host';
    // Operator privilege is granted only via Authorization: Bearer <token>.
    // The X-Api-Key fallback is host-only by design.
    const bearer = parseBearer(req.headers['authorization']);
    if (!bearer) return 'host';
    if (bearer.length !== operatorToken.length) return 'host';
    const a = Buffer.from(bearer);
    const b = Buffer.from(operatorToken);
    if (a.length !== b.length) return 'host';
    return timingSafeEqual(a, b) ? 'operator' : 'host';
  }

  function clientIp(req: FastifyRequest): string | null {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]?.trim() ?? null;
    if (Array.isArray(fwd) && fwd[0]) return fwd[0].split(',')[0]?.trim() ?? null;
    return req.ip ?? null;
  }

  // GET /mcp — probe (advisory only).
  app.get('/mcp', async (req, reply) => {
    const origin = (req.headers['origin'] ?? '') as string;
    if (!ctx.env.MCP_ALLOW_REQUEST_HOST_ORIGIN && origin) {
      raw(reply).code(403).header('content-type', 'text/plain').send('Origin not allowed');
      return;
    }
    reply.header('Allow', 'POST');
    raw(reply).code(405).header('content-type', 'text/plain').send('POST only, JSON-RPC 2.0');
  });

  // POST /mcp — JSON-RPC dispatch.
  app.post('/mcp', async (req, reply) => {
    const origin = (req.headers['origin'] ?? '') as string;
    if (!ctx.env.MCP_ALLOW_REQUEST_HOST_ORIGIN && origin) {
      raw(reply).code(403).type('application/json').send(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32099, message: 'Origin not allowed' },
        id: null,
      }));
      return;
    }

    const host = await resolveHost(req);
    if (!host) {
      throw new UnauthorizedError('Invalid MCP credential', 'invalid_mcp_credential');
    }
    if (host.status && host.status !== 'active') {
      throw new ForbiddenError(`Host ${host.status}`, `host_${host.status}`);
    }

    const body = req.body;
    const engineHeader = req.headers['x-engine'];
    const engine = isEngine(engineHeader) ? engineHeader : ENGINE_CODEX;
    assertHostEngineEnabled(host, engine);
    const result = await server.handlePayload(body, {
      host,
      clientIp: clientIp(req),
      serverVersion: '2.0.0',
      capability: detectCapability(req),
      engine,
    });

    if (result === null) {
      raw(reply).code(202).send();
      return;
    }

    raw(reply).type('application/json').code(200).send(JSON.stringify(result));
  });
}
