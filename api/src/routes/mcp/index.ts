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
import type { RouteContext } from '../index.js';
import { raw } from '../../http/reply.js';
import { ForbiddenError, UnauthorizedError } from '../../http/errors.js';
import { extractApiKey } from '../../util/api-key-helpers.js';

import { McpSessionService } from '../../services/mcp-session.js';
import { McpAccessLogService } from '../../services/mcp-access-log.js';
import { McpMemoriesService } from '../../services/mcp-memories.js';
import { HostProjectsService } from '../../services/host-projects.js';
import { HostSkillsService } from '../../services/host-skills.js';
import { McpToolsRegistry } from '../../services/mcp-tools.js';
import { McpResourcesService } from '../../services/mcp-resources.js';
import { McpServer } from '../../services/mcp-server.js';
import type { Host } from '../../db/schema.js';

export async function registerMcpRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const sessions = new McpSessionService(ctx.db);
  const accessLog = new McpAccessLogService(ctx.db);
  const memories = new McpMemoriesService(ctx.db);
  const projects = new HostProjectsService(ctx.db);
  const skills = new HostSkillsService(ctx.db);
  const tools = new McpToolsRegistry({ memories, projects, skills });
  const resources = new McpResourcesService({ memories, projects, skills });
  const server = new McpServer(tools, resources, accessLog);

  async function resolveHost(req: FastifyRequest): Promise<Host | null> {
    const key = extractApiKey(req.headers as Record<string, string | string[] | undefined>);
    if (!key) return null;
    const fromSession = await sessions.verify(key);
    if (fromSession) return fromSession;
    return app.resolveHostFromKey(req);
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
    const result = await server.handlePayload(body, {
      host,
      clientIp: clientIp(req),
      serverVersion: '2.0.0',
    });

    if (result === null) {
      raw(reply).code(202).send();
      return;
    }

    raw(reply).type('application/json').code(200).send(JSON.stringify(result));
  });
}
