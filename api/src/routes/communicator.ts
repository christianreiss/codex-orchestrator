import { McpSessionService } from '../services/mcp-session.js';
import { parseBearer } from '../util/api-key-helpers.js';
import { EventEmitter } from 'node:events';
import { attachHostDaemonSocket, type DaemonSocket } from './host-daemon.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { versions } from '../db/schema.js';
import { createHostAuthService } from '../services/host-auth.js';
import { registerWebsocketTransport } from '../ws/transport.js';
import { wsPublisher } from '../ws/publisher.js';
import { ForbiddenError } from '../http/errors.js';
import type { RouteContext } from './index.js';

// HTTP envelopes retain the existing route authorization, validation, audit and
// response contracts. Neither arbitrary URLs nor admin/provider routes are tunnelled.
// The API router ignores trailing slashes, so every check (and the MCP
// credential pinning) must see the pathname the router will dispatch.
export function communicatorPathname(path: string): string {
  return path.split('?')[0]!.replace(/(.)\/+$/, '$1');
}

export function communicatorPathAllowed(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /[%\\#\r\n]/.test(path.split('?')[0]!)) return false;
  const pathname = communicatorPathname(path);
  if (pathname.split('/').some((p) => p === '.' || p === '..')) return false;
  if (
    pathname.startsWith('/host/communicator') ||
    pathname.endsWith('/connect') ||
    pathname.endsWith('/stream')
  )
    return false;
  return /^(?:\/auth(?:\/sessions(?:\/(?:heartbeat|release))?)?|\/versions|\/skills(?:\/[^?]*)?|\/agents\/retrieve|\/config\/retrieve|\/sync\/(?:bootstrap|status)|\/cron\/(?:check|report)|\/mcp(?:\/[^?]*)?|\/host\/[^?]+|\/wrapper\/(?:v2\/)?[^?]+|\/claude\/usage\/report)$/.test(
    pathname,
  );
}

const requestSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal('request'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
    path: z.string().max(8192).refine(communicatorPathAllowed),
    headers: z.record(z.string().max(16384)).default({}),
    body: z.string().max(900_000).default(''),
  })
  .strict();
const allowedHeaders = new Set([
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'x-engine',
  'x-agent-bridge-token',
  'x-agent-relay-token',
  'x-wrapper-platform',
  'x-wrapper-version',
  'x-cxx-version',
  'if-none-match',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

export interface CommunicatorView {
  host_id: number;
  username: string;
  version: string;
  connected_at: string;
  sessions: number;
  requests: number;
  synced_at: string | null;
  sync_scopes?: unknown[];
}
const connections = new Map<string, CommunicatorView>();

export async function registerCommunicatorRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  const auth = createHostAuthService(ctx);
  const mcpSessions = new McpSessionService(ctx.db);
  const authorize = async (req: FastifyRequest) => {
    if (!ctx.env.CXX_COMMUNICATOR_ENABLED)
      throw new ForbiddenError('Communicator is disabled', 'communicator_disabled');
    const [kill] = await ctx.db.select().from(versions).where(eq(versions.name, 'api_disabled'));
    if (kill?.version === '1') throw new ForbiddenError('API disabled', 'api_disabled');
    return auth.authenticate(req);
  };
  app.get('/admin/communicators', { preHandler: app.requireAdmin }, async () => ({
    enabled: ctx.env.CXX_COMMUNICATOR_ENABLED,
    protocol: 1,
    connections: [...connections.values()],
  }));
  app.get(
    '/host/communicator/connect',
    {
      websocket: true,
      preValidation: async (req) => {
        await authorize(req);
      },
    },
    (socket, req) => {
      const connectionID = randomUUID();
      let closed = false,
        inFlight = 0,
        greeted = false;
      const send = (frame: unknown) => {
        if (closed) return;
        if (socket.bufferedAmount > 8 * 1024 * 1024) {
          socket.close(1013, 'Slow consumer');
          return;
        }
        socket.send(JSON.stringify(frame));
      };
      const daemonEvents = new EventEmitter();
      let daemonAttached = false;
      const daemonSocket = Object.assign(daemonEvents, {
        send: (data: string) => send({ type: 'daemon_event', payload: JSON.parse(data) }),
        close: () => {
          daemonEvents.emit('close');
          daemonEvents.removeAllListeners();
          daemonAttached = false;
          send({ type: 'daemon_closed' });
        },
      }) as DaemonSocket;
      // Only an invalidation is broadcast, never administrative event payloads.
      let dirty = false;
      let authDirty = false;
      const knownAccounts = new Map<string, number>();
      const authChanges = new Map<string, { engine: string; account_id: number; generation: number }>();
      const unsubscribe = wsPublisher.subscribe((event) => {
        const payload = event.payload as Record<string, unknown> | null;
        if (event.type === 'auth.canonical') {
          const engine = payload?.engine;
          const account = payload?.account_id;
          const generation = payload?.generation;
          const key = `${engine}:${account}`;
          if (
            typeof engine === 'string' &&
            typeof account === 'number' &&
            typeof generation === 'number' &&
            (knownAccounts.get(key) ?? 0) > Date.now()
          ) {
            authChanges.set(key, { engine, account_id: account, generation });
          } else {
            authDirty = true;
          }
          return;
        }
        if (/^(auth\.|accounts\.)/.test(event.type)) {
          authDirty = true;
          return;
        }
        // Config retrieval and daemon liveness also emit host events. They must
        // not trigger another sync and create an invalidation feedback loop.
        if (
          event.type === 'host.updated' &&
          (payload?.config_version !== undefined ||
            payload?.source === 'cron_report' ||
            payload?.source === 'daemon_window')
        )
          return;
        if (/^host\.daemon\.(?:changed|start_requested|stop_requested)$/.test(event.type)) return;
        if (
          /^(skill\.|agents\.|config\.|auth\.|accounts\.|host\.|engine\.|version|settings\.|claude_artifact\.)/.test(
            event.type,
          )
        )
          dirty = true;
      });
      const invalidationTimer = setInterval(() => {
        if (greeted && authChanges.size > 0) {
          for (const change of authChanges.values()) send({ type: 'auth_changed', ...change });
          authChanges.clear();
        }
        if (authDirty && greeted) {
          authDirty = false;
          send({ type: 'auth_changed' });
        }
        if (dirty && greeted) {
          dirty = false;
          send({ type: 'invalidate', revision: randomUUID() });
        }
      }, 250);
      const timer = setInterval(() => {
        void authorize(req)
          .then(() => {
            /* Authorization is rechecked independently of content invalidations. */
          })
          .catch(() => socket.close(1008, 'Authorization changed'));
      }, 15000);
      socket.on('message', (raw: { toString(): string }) => {
        // Set once a greeted request frame names a valid id: its own malformed
        // contents then fail only that request, never the shared connection.
        let rejectable: string | undefined;
        let rejectStatus = 400;
        void (async () => {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'hello') {
            const hello = z
              .object({
                type: z.literal('hello'),
                protocol: z.literal(1),
                username: z.string().min(1).max(128),
                version: z.string().max(64),
              })
              .strict()
              .parse(parsed);
            const host = await authorize(req);
            connections.set(connectionID, {
              host_id: host.id,
              username: hello.username,
              version: hello.version,
              connected_at: new Date().toISOString(),
              sessions: 0,
              requests: 0,
              synced_at: null,
            });
            wsPublisher.publish('communicator.updated', { host_id: host.id });
            greeted = true;
            send({ type: 'ready', protocol: 1 });
            return;
          }
          if (!greeted) throw new Error('Handshake required');
          if (parsed.type === 'daemon_disconnect') {
            daemonEvents.emit('close');
            daemonEvents.removeAllListeners();
            daemonAttached = false;
            return;
          }
          if (parsed.type === 'daemon') {
            await authorize(req);
            if (!daemonAttached) {
              attachHostDaemonSocket(daemonSocket, req, ctx);
              daemonAttached = true;
            }
            const data = JSON.stringify(parsed.payload);
            if (data.length > 256_000) throw new Error('Daemon frame too large');
            daemonEvents.emit('message', data);
            return;
          }
          if (parsed.type === 'heartbeat') {
            const heartbeat = z
              .object({
                type: z.literal('heartbeat'),
                sessions: z.number().int().min(0).max(10000),
                synced_at: z.string().datetime().nullable().default(null),
                sync_scopes: z
                  .array(
                    z
                      .object({
                        scope: z.string().max(100),
                        running: z.boolean(),
                        content_error: z.string().max(128),
                        auth: z
                          .object({
                            type: z.literal('auth_state'),
                            scope: z.string().max(100),
                            engine: z.enum(['codex', 'claude', 'grok']),
                            account_id: z.number().int().positive().optional(),
                            generation: z.string().max(128).optional(),
                            state: z.string().max(32),
                            native_adoption: z.string().max(32),
                            updated_at: z.string().max(40).optional(),
                            host_status: z.string().max(40).optional(),
                            error: z.string().max(160).optional(),
                            host_secure: z.boolean().optional(),
                            fatal: z.boolean().optional(),
                          })
                          .strict(),
                      })
                      .strict(),
                  )
                  .max(1000)
                  .optional(),
              })
              .strict()
              .parse(parsed);
            await authorize(req);
            const view = connections.get(connectionID)!;
            view.sessions = heartbeat.sessions;
            view.synced_at = heartbeat.synced_at;
            view.sync_scopes = heartbeat.sync_scopes;
            wsPublisher.publish('communicator.updated', { host_id: view.host_id });
            send({ type: 'heartbeat' });
            return;
          }
          if (parsed.type === 'request' && z.string().uuid().safeParse(parsed.id).success)
            rejectable = parsed.id;
          const frame = requestSchema.parse(parsed);
          if (inFlight >= 128) {
            send({ id: frame.id, status: 429, headers: {}, body: '', error: 'communicator_busy' });
            return;
          }
          inFlight++;
          try {
            rejectable = undefined;
            await authorize(req);
            rejectable = frame.id;
            rejectStatus = 500;
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(frame.headers)) {
              if (
                allowedHeaders.has(name.toLowerCase()) &&
                (name.toLowerCase() !== 'authorization' || communicatorPathname(frame.path) === '/mcp')
              )
                headers[name.toLowerCase()] = value;
            }
            // Host key and remote IP are bound to the authenticated connection.
            // Never accept forwarding headers, cookies or another host key in a frame.
            headers['x-api-key'] = String(req.headers['x-api-key'] ?? '');
            if (communicatorPathname(frame.path) === '/mcp') {
              const bearer = parseBearer(headers.authorization);
              if (bearer !== headers['x-api-key']) {
                const tokenHost = bearer ? await mcpSessions.verify(bearer) : null;
                if (!tokenHost || tokenHost.id !== req.authHost?.id) {
                  send({
                    id: frame.id,
                    status: 401,
                    headers: { 'content-type': 'application/json' },
                    body: Buffer.from(
                      JSON.stringify({
                        code: 'communicator_mcp_host_mismatch',
                        message: 'MCP credential does not belong to this connection',
                      }),
                    ).toString('base64'),
                  });
                  return;
                }
              }
            }

            const response = await app.inject({
              method: frame.method,
              url: frame.path,
              headers,
              remoteAddress: req.clientIp || req.socket.remoteAddress,
              ...(frame.body ? { payload: Buffer.from(frame.body, 'base64') } : {}),
            });
            if (
              response.statusCode < 400 &&
              ['/auth', '/sync/bootstrap'].includes(communicatorPathname(frame.path))
            ) {
              try {
                let result = JSON.parse(response.rawPayload.toString());
                result = result.data ?? result;
                if (communicatorPathname(frame.path) === '/sync/bootstrap') result = result.auth;
                if (
                  result?.verification_state === 'verified' &&
                  typeof result.account_id === 'number' &&
                  ['codex', 'claude', 'grok'].includes(result.engine)
                ) {
                  knownAccounts.set(`${result.engine}:${result.account_id}`, Date.now() + 60_000);
                }
              } catch {
                /* A non-JSON/error response grants no subscription. */
              }
            }
            const view = connections.get(connectionID);
            if (view) view.requests++;
            const replyHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (
                value !== undefined &&
                !['connection', 'transfer-encoding', 'content-length', 'set-cookie'].includes(key)
              )
                replyHeaders[key] = String(value);
            }
            send({
              id: frame.id,
              status: response.statusCode,
              headers: replyHeaders,
              body: response.rawPayload.toString('base64'),
            });
          } finally {
            inFlight--;
          }
        })().catch(() => {
          if (rejectable && !closed) {
            send({
              id: rejectable,
              status: rejectStatus,
              headers: { 'content-type': 'application/json' },
              body: Buffer.from(
                JSON.stringify({ code: 'communicator_invalid_request', message: 'Request frame rejected' }),
              ).toString('base64'),
            });
            return;
          }
          socket.close(1008, 'Invalid or unauthorized communicator request');
        });
      });
      socket.on('close', () => {
        closed = true;
        clearInterval(timer);
        clearInterval(invalidationTimer);
        unsubscribe();
        daemonEvents.emit('close');
        connections.delete(connectionID);
        wsPublisher.publish('communicator.updated', {});
      });
      socket.on('error', () => socket.close());
    },
  );
}
