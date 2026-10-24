import { McpSessionService } from '../services/mcp-session.js';
import { parseBearer } from '../util/api-key-helpers.js';
import { EventEmitter } from 'node:events';
import { attachHostDaemonSocket, type DaemonSocket } from './host-daemon.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHostAuthService } from '../services/host-auth.js';
import { registerWebsocketTransport } from '../ws/transport.js';
import { wsPublisher } from '../ws/publisher.js';
import { ForbiddenError } from '../http/errors.js';
import {
  communicatorRegistry,
  connections,
  type CommunicatorView,
} from '../services/topology/communicator-registry.js';
import type { RouteContext } from './index.js';
import { join, resolve } from 'node:path';
import { createWrapperBinRegistry } from '../services/wrapper-bin-registry.js';
import { startWrapperPublishWatch } from '../services/wrapper-publish-watch.js';
import { createAgentPortalService } from '../services/agent-portal.js';
import { openNativeControlStream } from '../services/native-control-stream.js';

export type { CommunicatorView };

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
  // Transfers never belong on the control socket: the wrapper's owner sends them over
  // their own HTTPS stream. Refusing them before dispatch means the router never
  // buffers (and base64-encodes) a binary or attachment for a frame, whatever a caller
  // sends. This is the exact predicate the owner applies (server.go ServeHTTP).
  if (
    pathname.startsWith('/wrapper/v2/bin/') ||
    pathname.startsWith('/wrapper/v2/download') ||
    pathname.startsWith('/wrapper/download') ||
    pathname.includes('/download') ||
    pathname.includes('/attachments/')
  )
    return false;
  return /^(?:\/auth(?:\/sessions(?:\/(?:heartbeat|release))?)?|\/versions|\/skills(?:\/[^?]*)?|\/agents\/retrieve|\/config\/retrieve|\/sync\/(?:bootstrap|status|cache)|\/cron\/(?:check|report)|\/mcp(?:\/[^?]*)?|\/host\/[^?]+|\/wrapper\/(?:v2\/)?[^?]+|\/claude\/usage\/report)$/.test(
    pathname,
  );
}

// cxx 0.9.71–0.9.74 owners send the self-update download (the canonical bakery URL)
// as a control frame, because its path carries none of their transfer markers, and
// have no fallback when it is refused — so those hosts could never update. Their
// updater follows redirects through the same owner, which sends any path containing
// "/download" over its own HTTPS stream. Answer exactly that GET with a 307 to the
// version- and platform-exact /wrapper/v2/download alias; the binary itself never
// enters a frame. The Location is relative to the request URL so it stays on the
// same host (the updater keeps X-API-Key) and under any base-URL path prefix.
const legacyBinPath = /^\/wrapper\/v2\/bin\/([a-z0-9]+)\/([a-z0-9]+-[a-z0-9]+)\/v([A-Za-z0-9][A-Za-z0-9._+-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
export function legacyBinaryRedirect(frame: { method?: unknown; path?: unknown }): string | null {
  if (frame.method !== 'GET' || typeof frame.path !== 'string') return null;
  const m = legacyBinPath.exec(frame.path);
  if (!m) return null;
  return `../../../../download/${m[1]}/${m[2]}/v${m[3]}/${m[4]}`;
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
// Base64 of a body above this size would exceed the wrapper's 16 MiB frame cap.
// That request gets a small correlated failure and the socket stays up.
const MAX_RESPONSE_BYTES = 11 * 1024 * 1024;
// The wrapper rejects a control frame above 16 MiB. The payload cap above keeps
// the common case cheap; this one measures the encoded frame as it will travel
// (base64 body + headers + JSON), with a 1 MiB margin.
const MAX_FRAME_BYTES = 15 * 1024 * 1024;

// A lost result is retryable only when the operation itself was a known read.
// In particular, bootstrap may carry auth or admit a native session. Keep this
// aligned with the wrapper's byte-identical content-read contract.
export function communicatorResponseMayRepeat(frame: {
  method: string;
  path: string;
  body: string;
}): boolean {
  if (frame.method === 'GET' || frame.method === 'HEAD') return true;
  if (frame.method !== 'POST') return false;
  const pathname = communicatorPathname(frame.path);
  if (pathname === '/agents/retrieve' || pathname === '/config/retrieve') return true;
  if (pathname !== '/sync/bootstrap') return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(frame.body, 'base64').toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const fields = parsed as Record<string, unknown>;
    return (
      fields.include_auth === false &&
      !Object.hasOwn(fields, 'auth_candidate') &&
      !Object.hasOwn(fields, 'session_id')
    );
  } catch {
    return false;
  }
}

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

export async function registerCommunicatorRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  // Push-triggered updater: owners that see `wrapper_update` in ready.control
  // receive payload-free `update_available` triggers and read the target from
  // their signed config and /cron/check, never from the frame.
  const updateEnabled = Boolean(ctx.env.CXX_COMMUNICATOR_ENABLED && ctx.env.CXX_COMMUNICATOR_UPDATE_ENABLED);
  if (updateEnabled) {
    const binRoot = ctx.env.DATA_ROOT
      ? join(ctx.env.DATA_ROOT, 'wrapper', 'v2', 'bin')
      : resolve(import.meta.dirname, '..', '..', '..', 'storage', 'wrapper', 'v2', 'bin');
    const stopWatch = startWrapperPublishWatch(createWrapperBinRegistry({ binRoot }));
    app.addHook('onClose', async () => stopWatch());
  }
  const auth = createHostAuthService(ctx);
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const mcpSessions = new McpSessionService(ctx.db);
  const authorize = async (req: FastifyRequest) => {
    if (!ctx.env.CXX_COMMUNICATOR_ENABLED)
      throw new ForbiddenError('Communicator is disabled', 'communicator_disabled');
    return auth.authenticate(req, { checkApiDisabled: true });
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
      const nativeStreams = new Map<string, () => void>();
      let lastFrameAt = Date.now();
      let closed = false,
        inFlight = 0,
        greeted = false,
        hostId = 0;
      const sendText = (text: string) => {
        if (closed) return;
        if (socket.bufferedAmount > 8 * 1024 * 1024) {
          socket.close(1013, 'Slow consumer');
          return;
        }
        socket.send(text);
      };
      const send = (frame: unknown) => sendText(JSON.stringify(frame));
      // What a reply that cannot travel, or a failure after dispatch, tells the caller.
      // A read may be repeated; anything that may have changed state is reported as
      // unknown (409) so no caller replays it.
      const uncertainReply = (id: string, frame: { method: string; path: string; body: string }, why: 'oversize' | 'fault') => {
        const mayRepeat = communicatorResponseMayRepeat(frame);
        const code = mayRepeat
          ? why === 'oversize'
            ? 'communicator_response_too_large'
            : 'communicator_invalid_request'
          : 'communicator_outcome_unknown';
        const message = mayRepeat
          ? why === 'oversize'
            ? 'Response exceeds the communicator frame limit'
            : 'Request could not be completed'
          : 'The operation may have completed but its reply could not be delivered; verify the result before retrying';
        return {
          id,
          status: mayRepeat ? (why === 'oversize' ? 502 : 500) : 409,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ code, message })).toString('base64'),
        };
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
      let updateDirty = false;
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
        // Quota readings and policy ride the /auth response, so they invalidate it
        // too. cxx 0.9.121 re-runs an unpushed auth job only every 5 minutes.
        if (/^(auth\.|accounts\.|quota\.|chatgpt\.usage\.|claude\.usage\.)/.test(event.type)) {
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
        // A named host event changes only that host. Another host's lane change or
        // admin edit must not make this connection resynchronize. An event with no
        // numeric id still reaches every connection.
        if (event.type.startsWith('host.')) {
          const named = payload?.id ?? payload?.host_id;
          if (typeof named === 'number' && Number.isInteger(named) && hostId !== 0 && named !== hostId) return;
        }
        if (
          /^(skill\.|agents\.|config\.|auth\.|accounts\.|host\.|engine\.|version|settings\.|claude_artifact\.)/.test(
            event.type,
          )
        )
          dirty = true;
        // A release, rollout step, host version policy or fleet setting may
        // change this host's update target.
        if (/^(version|settings\.changed$|host\.updated$)/.test(event.type)) updateDirty = true;
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
        if (updateDirty && greeted && updateEnabled) {
          updateDirty = false;
          send({ type: 'update_available' });
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
        // Set the moment the request is handed to the router: from then on a fault
        // cannot be taken to mean "nothing happened".
        let dispatched: { method: string; path: string; body: string } | undefined;
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
            hostId = host.id;
            communicatorRegistry.register(
              {
                id: connectionID,
                host_id: host.id,
                username: hello.username,
                version: hello.version,
                connected_at: new Date().toISOString(),
                sessions: 0,
                requests: 0,
                synced_at: null,
              },
              {
                close: (code, reason) => socket.close(code, reason),
                terminate: () => socket.terminate(),
                send,
                remoteAddress: req.clientIp || req.socket.remoteAddress || null,
              },
            );
            wsPublisher.publish('communicator.updated', { host_id: host.id });
            greeted = true;
            // `control` offers the owner remote termination (see services/topology);
            // an owner that does not know the field ignores it and is never asked.
            // `owner_identity` says this server accepts the owner's process identity
            // in `capabilities` and aims a stop at exactly one process: an owner that
            // sees `terminate` without it sends only the legacy fields.
            send({
              type: 'ready',
              protocol: 1,
              control: ['terminate', 'owner_identity', 'resident_runtime', 'native_control_events', ...(updateEnabled ? ['wrapper_update'] : [])],
            });
            return;
          }
          if (!greeted) throw new Error('Handshake required');
          communicatorRegistry.touch(connectionID);
          lastFrameAt = Date.now();
          if (parsed.type === 'native_control_unsubscribe') {
            const frame = z.object({ type: z.literal('native_control_unsubscribe'), id: z.string().uuid() }).strict().parse(parsed);
            nativeStreams.get(frame.id)?.();
            nativeStreams.delete(frame.id);
            return;
          }
          if (parsed.type === 'native_control_subscribe') {
            const frame = z.object({
              type: z.literal('native_control_subscribe'), id: z.string().uuid(),
              session_id: z.string().uuid(), instance_id: z.string().uuid(),
              bridge_token: z.string().min(1).max(1024),
            }).strict().parse(parsed);
            if (nativeStreams.has(frame.id) || nativeStreams.size >= 256) throw new Error('Native stream limit');
            nativeStreams.set(frame.id, openNativeControlStream({
              db: ctx.db, sessionId: frame.session_id, instanceId: frame.instance_id,
              alive: () => !closed && Date.now() - lastFrameAt < 45_000,
              authenticate: async () => {
                const host = await authorize(req);
                await portal.authenticateBridge(frame.session_id, frame.bridge_token, host.id);
              },
              send: (status, payload) => send({ type: 'native_control', id: frame.id, status, payload }),
            }));
            return;
          }
          if (parsed.type === 'capabilities') {
            const caps = z
              .object({
                type: z.literal('capabilities'),
                terminate: z.boolean(),
                pid: z.number().int().positive().max(2 ** 31),
                started_at: z.string().max(40),
                // Optional: an owner that predates identity sends neither.
                instance_id: z.string().max(64).optional(),
                runtime_id: z.string().max(64).optional(),
              })
              .strict()
              .parse(parsed);
            communicatorRegistry.setCapabilities(connectionID, {
              terminate: caps.terminate,
              pid: caps.pid,
              started_at: caps.started_at,
              instance_id: caps.instance_id ?? null,
              runtime_id: caps.runtime_id ?? null,
            });
            wsPublisher.publish('communicator.updated', { host_id: hostId });
            return;
          }
          if (parsed.type === 'resident_status') {
            const count = z.number().int().min(0).max(1_000_000);
            const result = z.object({
              type: z.literal('resident_status'),
              sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
              owner_instance_id: z.string().uuid(),
              runtime_protocol: z.literal(1),
              mode: z.enum(['on_demand', 'resident']),
              managed: z.boolean(),
              resident_enabled: z.boolean(),
              execution_enabled: z.boolean(),
              binary_sha256: z.string().regex(/^[a-f0-9]{64}$/),
              draining: z.boolean(),
              local_requests: count,
              legacy_clients: count,
              execution: z.object({
                running: z.boolean(), fenced: z.boolean(), verified: z.boolean(),
                workload: z.object({
                  accepted: count, peer_claims: count, children: count, receipts: count,
                  writes: count, requests: count, legacy_clients: count,
                }).strict(),
              }).strict().nullable(),
            }).strict().safeParse(parsed);
            // Diagnostics grant nothing. Unknown versions/fields and wrong
            // identities must not drop request relay or remote control. The
            // existing heartbeat rechecks host authorization every 15 seconds.
            if (!result.success) return;
            const { type: _type, ...report } = result.data;
            if (!communicatorRegistry.setResidentReport(connectionID, report)) return;
            wsPublisher.publish('communicator.updated', { host_id: hostId });
            return;
          }
          if (parsed.type === 'terminate_ack') {
            const ack = z
              .object({
                type: z.literal('terminate_ack'),
                request_id: z.string().uuid(),
                accepted: z.boolean(),
                pid: z.number().int().positive().max(2 ** 31).optional(),
                reason: z.string().max(64).optional(),
                instance_id: z.string().max(64).optional(),
              })
              .strict()
              .parse(parsed);
            communicatorRegistry.acknowledgeTerminate(connectionID, ack.request_id, {
              accepted: ack.accepted,
              pid: ack.pid ?? null,
              reason: ack.reason || null,
              instance_id: ack.instance_id ?? null,
            });
            return;
          }
          if (parsed.type === 'daemon_disconnect') {
            daemonEvents.emit('close');
            daemonEvents.removeAllListeners();
            daemonAttached = false;
            communicatorRegistry.setDaemonAttached(connectionID, false);
            return;
          }
          if (parsed.type === 'daemon') {
            await authorize(req);
            if (!daemonAttached) {
              attachHostDaemonSocket(daemonSocket, req, ctx);
              daemonAttached = true;
              communicatorRegistry.setDaemonAttached(connectionID, true);
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
                        // cxx 0.9.81 owners report whether a scope holds current content
                        // (warm-cache launches). Unknown here, it failed the strict parse and
                        // closed every such owner after its first heartbeat; it redialled ~17 s
                        // later, so connections and tombstones piled up.
                        primed: z.boolean().optional(),
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
            communicatorRegistry.heartbeat(connectionID);
            wsPublisher.publish('communicator.updated', { host_id: view.host_id });
            send({ type: 'heartbeat' });
            return;
          }
          if (parsed.type === 'request' && z.string().uuid().safeParse(parsed.id).success)
            rejectable = parsed.id;
          const legacyBin = rejectable ? legacyBinaryRedirect(parsed) : null;
          if (legacyBin) {
            await authorize(req);
            send({ id: parsed.id, status: 307, headers: { location: legacyBin }, body: '' });
            return;
          }
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

            dispatched = { method: frame.method, path: frame.path, body: frame.body };
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
            try {
              communicatorRegistry.observeDispatch(
                connectionID,
                frame.method,
                communicatorPathname(frame.path),
                response.statusCode,
                response.rawPayload,
              );
            } catch {
              /* Topology bookkeeping must never replace the reply of a request that already ran. */
            }
            if ((response.rawPayload?.length ?? 0) > MAX_RESPONSE_BYTES) {
              send(uncertainReply(frame.id, frame, 'oversize'));
              return;
            }
            const replyHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (
                value !== undefined &&
                !['connection', 'transfer-encoding', 'content-length', 'set-cookie'].includes(key)
              )
                replyHeaders[key] = String(value);
            }
            const encoded = JSON.stringify({
              id: frame.id,
              status: response.statusCode,
              headers: replyHeaders,
              body: response.rawPayload.toString('base64'),
            });
            if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
              send(uncertainReply(frame.id, frame, 'oversize'));
              return;
            }
            sendText(encoded);
          } finally {
            inFlight--;
          }
        })().catch(() => {
          if (rejectable && dispatched && !closed) {
            send(uncertainReply(rejectable, dispatched, 'fault'));
            return;
          }
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
        for (const stop of nativeStreams.values()) stop();
        nativeStreams.clear();
        clearInterval(timer);
        clearInterval(invalidationTimer);
        unsubscribe();
        daemonEvents.emit('close');
        communicatorRegistry.unregister(connectionID);
        wsPublisher.publish('communicator.updated', {});
      });
      socket.on('error', () => socket.close());
    },
  );
}
