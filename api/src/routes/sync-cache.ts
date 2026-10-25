import { createHash } from 'node:crypto';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { authoritativeReads, authoritativeSnapshot } from '../db/fresh-read.js';
import { createHostAuthService } from '../services/host-auth.js';
import { McpSessionService } from '../services/mcp-session.js';
import { parseBearer } from '../util/api-key-helpers.js';
import {
  cacheManifest,
  cacheSourceAllowed,
  COMMUNICATOR_CACHE_PROTOCOL,
  LOCAL_CONTENT_CACHE_PROTOCOL,
  localContentSource,
} from '../services/communicator-cache.js';
import { resolveAuthRequestEngine } from './auth/engine-resolution.js';
import { assertHostEngineEnabled } from '../services/host-engine-policy.js';
import { readFleetEngineState } from '../services/engine-switch.js';
import { ConflictError, ForbiddenError, ValidationError } from '../http/errors.js';

const schema = z
  .object({
    protocol: z.union([z.literal(COMMUNICATOR_CACHE_PROTOCOL), z.literal(LOCAL_CONTENT_CACHE_PROTOCOL)]),
    request_id: z.string().uuid(),
    method: z.enum(['GET', 'POST']),
    path: z.string().max(1024),
    body: z.record(z.unknown()).default({}),
    headers: z.record(z.string().max(16384)).default({}),
    known: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  })
  .strict();

const forwardHeaders = new Set([
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'x-engine',
  'x-wrapper-version',
  'x-cxx-version',
  'x-wrapper-platform',
  'mcp-session-id',
  'mcp-protocol-version',
  'x-agent-bridge-token',
  'x-agent-relay-token',
]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeBootstrap(content: Record<string, unknown>, auth: Record<string, unknown>) {
  const reasons = [
    ...new Set([
      ...(Array.isArray(content.reasons) ? content.reasons : []),
      ...(Array.isArray(auth.reasons) ? auth.reasons : []),
    ]),
  ];
  return {
    ...content,
    ...(auth.auth !== undefined ? { auth: auth.auth } : {}),
    reasons,
    status:
      reasons.length || content.status === 'update' || auth.status === 'update' ? 'update' : content.status,
  };
}

export async function registerSyncCacheRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const auth = createHostAuthService(ctx);
  const sessions = new McpSessionService(ctx.db);
  app.post('/sync/cache', async (req, reply) =>
    authoritativeReads(async () => {
      if (!ctx.env.CXX_COMMUNICATOR_ENABLED || !ctx.env.CXX_COMMUNICATOR_SYNC_ENABLED)
        throw new ForbiddenError('Communicator cache is disabled', 'communicator_cache_disabled');
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Invalid cache read');
      const input = parsed.data;
      const pathname = new URL(input.path, 'http://cache.local').pathname;
      if (!cacheSourceAllowed(input.method, input.path, input.body))
        throw new ValidationError('Unsupported cache read');
      if (
        input.protocol === LOCAL_CONTENT_CACHE_PROTOCOL &&
        !localContentSource(input.method, input.path, input.body)
      )
        throw new ValidationError('Operation requires a live server decision');
      const host = await auth.authenticate(req, { checkApiDisabled: true });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.headers)) {
        if (!forwardHeaders.has(key.toLowerCase())) throw new ValidationError('Unsupported cache header');
        headers[key.toLowerCase()] = value;
      }
      headers['x-api-key'] = String(req.headers['x-api-key'] ?? '');
      // The original MCP route must authenticate too; it may not change this host binding.
      if (pathname === '/mcp') {
        const bearer = parseBearer(headers.authorization);
        if (bearer !== headers['x-api-key']) {
          const boundHost = bearer ? await sessions.verify(bearer) : null;
          if (boundHost?.id !== host.id)
            throw new ForbiddenError(
              'MCP credential belongs to another host',
              'communicator_mcp_host_mismatch',
            );
        }
        headers['x-cxx-communicator'] = '1';
      }
      const query = Object.fromEntries(new URL(input.path, 'http://cache.local').searchParams);
      const engine = resolveAuthRequestEngine({ headers, query }, input.body);
      assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
      const cacheGrantUntil = () => {
        const deadlines = [host.expiresAt].filter((s): s is string => !!s);
        if (pathname === '/mcp') {
          const bearer = parseBearer(headers.authorization);
          if (bearer && bearer !== headers['x-api-key']) {
            const state = ownerRuntimeFor(ctx.db)?.state.snapshot();
            const token = state
              ?.table('mcpSessionTokens')
              .by('token', createHash('sha256').update(bearer).digest('hex'))[0];
            // A legacy SQL-backed caller has no push-coherent token catalogue.
            if (!token) return new Date(checkedAt).toISOString();
            deadlines.push(token.expiresAt);
          }
        }
        return deadlines.sort()[0] ?? null;
      };
      let unsafeDispatched = false;
      const dispatch = (body: Record<string, unknown>) => {
        if (pathname === '/auth/sessions' || (pathname === '/sync/bootstrap' && body.include_auth !== false))
          unsafeDispatched = true;
        return app.inject({
          method: input.method,
          url: input.path,
          headers,
          remoteAddress: req.clientIp || req.socket.remoteAddress,
          ...(input.method === 'POST' ? { payload: body } : {}),
        });
      };
      // Timestamp the beginning of this check, not the completion of rendering.
      const checkedAt = Date.now();
      try {
        // Always obtain canonical bytes, including when the native disk already has them.
        const contentBody = { ...input.body };
        for (const key of ['agents', 'config', 'skills', 'artifacts', 'sha256']) delete contentBody[key];
        let response;
        let body: unknown;
        // Credential work retains its existing transactions and refresh owner. Content
        // renderers then share one consistent snapshot, rather than a mix of revisions.
        if (pathname === '/sync/bootstrap' && input.body.include_content === false) {
          response = await dispatch(input.body);
          body = response.json();
        } else if (pathname === '/sync/bootstrap') {
          let authBody: Record<string, unknown> = {};
          if (
            input.body.include_auth !== false ||
            input.body.session_id !== undefined ||
            input.body.auth_candidate !== undefined
          ) {
            response = await dispatch({ ...input.body, include_content: false });
            if (response.statusCode >= 400)
              return reply.code(response.statusCode).type('application/json').send(response.rawPayload);
            authBody = object(response.json());
          }
          contentBody.include_auth = false;
          contentBody.include_content = true;
          delete contentBody.auth_candidate;
          delete contentBody.session_id;
          response = await authoritativeSnapshot(ctx.db, () => dispatch(contentBody));
          if (response.statusCode >= 400 && unsafeDispatched)
            throw new Error('Content read failed after credential exchange');
          const content = object(response.json());
          body = mergeBootstrap(content, authBody);
          // Standard envelopes duplicate fields under data. Keep both projections identical.
          if (content.data)
            (body as Record<string, unknown>).data = mergeBootstrap(
              object(content.data),
              object(authBody.data),
            );
        } else if (pathname === '/auth' || pathname === '/auth/sessions') {
          response = await dispatch(input.body);
          body = response.json();
        } else {
          response = await authoritativeSnapshot(ctx.db, () => dispatch(contentBody));
          body = response.json();
        }
        if (response.statusCode >= 400)
          return reply.code(response.statusCode).type('application/json').send(response.rawPayload);
        const manifest = cacheManifest(body, input.known, engine, host.secure === 1, checkedAt);
        const responseHeaders: Record<string, string> = {};
        for (const key of ['content-type', 'x-request-id', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = response.headers[key];
          if (value !== undefined)
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        reply.header('cache-control', 'no-store');
        return {
          data: {
            protocol: input.protocol,
            ...(input.protocol === LOCAL_CONTENT_CACHE_PROTOCOL
              ? {
                  local_content: host.secure === 1 && !!ownerRuntimeFor(ctx.db),
                  grant_until: cacheGrantUntil(),
                }
              : {}),
            request_id: input.request_id,
            checked_at: new Date(checkedAt).toISOString(),
            ...manifest,
            status: response.statusCode,
            headers: responseHeaders,
          },
        };
      } catch (error) {
        if (unsafeDispatched)
          throw new ConflictError(
            'Credential exchange or session admission ran; cache response unavailable',
            'communicator_outcome_unknown',
          );
        throw error;
      }
    }),
  );
}
