import { authorizeAgentInsecureEnable } from '../control-plane/streams/insecure-enable.js';
import { startOwnerWorker } from '../ops/owner-worker.js';
import { daemonSweepObligations } from '../control-plane/streams/daemon-deadlines.js';
import { ownerRuntimeFor, withOwnerRequestScope, setOwnerRequestPrincipal } from '../control-plane/state/runtime.js';
import { StreamAuthorization } from '../control-plane/streams/authorization.js';
import { canonicalCommand } from '../control-plane/commands.js';
import { asc, eq, inArray } from 'drizzle-orm';
import { registerWebsocketTransport } from '../ws/transport.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { hosts, hostDaemons, versions } from '../db/schema.js';
import { HostDaemonService } from '../services/host-daemon/service.js';
import { AdvisorService } from '../services/advisor.js';
import { internalHostIds, isInternalHost } from '../services/internal-hosts.js';
import { daemonSettingsSchema, daemonStartSchema, daemonAccepting, daemonExecutionEnabled } from '../services/host-daemon/policy.js';
import { createHostAuthService } from '../services/host-auth.js';
import { DAEMON_PERMISSION_MODES, PLAN_APPROVED_PROMPT } from '../services/host-daemon/permission-mode.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';
import { createAdminEventsService } from '../services/admin-events.js';
import { InsecureWindowAdminService } from '../services/insecure-window-admin.js';
import { makeAdminEventsWriter } from '../services/admin-events-writer.js';
import { ForbiddenError, NotFoundError } from '../http/errors.js';
import { wsPublisher } from '../ws/publisher.js';

export async function registerHostDaemonRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  const service = new HostDaemonService(ctx),
    auth = createHostAuthService(ctx);
  const messaging = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const events = createAdminEventsService(ctx.db);
  const advisor = new AdvisorService(ctx);
  const hostId = (req: FastifyRequest) =>
    z.coerce
      .number()
      .int()
      .positive()
      .parse((req.params as { id: string }).id);
  const sessionId = (req: FastifyRequest) =>
    z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
  const owner = async (req: FastifyRequest) => {
    const { session } = await messaging.authenticateBridge(
      (req.params as { sessionId: string }).sessionId,
      String(req.headers['x-agent-bridge-token'] ?? ''),
    );
    if (!session.agentBusAddressId) throw new ForbiddenError('Agent identity required');
    return `agent:${session.agentBusAddressId}`;
  };
  app.get('/admin/host-daemons', { preHandler: app.requireAdmin }, async () => {
    const hidden = await internalHostIds(ctx.db);
    const runtime=ownerRuntimeFor(ctx.db);runtime?.assertOwner();
    const rows = (runtime?runtime.state.snapshot().daemons.all():await ctx.db.select().from(hostDaemons)).filter((row) => !hidden.includes(row.hostId));
    return { hosts: await Promise.all(rows.map((row) => service.view(row.hostId))) };
  });
  // The advisor's server-owned host is managed by the stack, never by an admin.
  const fleetHostId = async (req: FastifyRequest) => {
    const id = hostId(req);
    if (isInternalHost(await service.host(id))) throw new NotFoundError('Host not found');
    return id;
  };
  app.get('/admin/hosts/:id/daemon', { preHandler: app.requireAdmin }, async (req) => service.view(await fleetHostId(req)));
  app.put('/admin/hosts/:id/daemon', { preHandler: app.requireAdmin }, async (req) => {
    await fleetHostId(req);
    const settings = daemonSettingsSchema.parse(req.body);
    const result = await service.configure(hostId(req), settings);
    await events.record({
      type: 'host.daemon.configured',
      payload: { host_id: hostId(req), settings, admin_user_id: req.admin!.user.id },
    });
    return result;
  });
  app.post('/admin/daemon-sessions', { preHandler: app.requireAdmin }, async (req, reply) => {
    const result = await service.start(
      daemonStartSchema.extend({ permission_mode: z.enum(DAEMON_PERMISSION_MODES).optional() }).strict().parse(req.body),
      `admin:${req.admin!.user.id}`,
    );
    reply.code(202);
    return result;
  });
  // Plan approval and mode switch from the console. With client_message_id
  // (mode default) it also resumes the session with the execution instruction.
  app.post('/admin/daemon-sessions/:id/permission-mode', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z
      .object({ mode: z.enum(DAEMON_PERMISSION_MODES), client_message_id: z.string().uuid().optional() })
      .strict()
      .refine((value) => value.mode === 'default' || !value.client_message_id, {
        path: ['client_message_id'],
        message: 'Only approval (mode default) resumes the session',
      })
      .parse(req.body ?? {});
    const actor = `admin:${req.admin!.user.id}`;
    const result = await service.setPermissionMode(sessionId(req), body.mode, undefined, actor);
    let operation: { operation_id: string } | null = null;
    if (body.client_message_id) {
      operation = await service.turn(sessionId(req), PLAN_APPROVED_PROMPT, body.client_message_id);
      reply.code(202);
    }
    return { ...result, operation_id: operation?.operation_id ?? null };
  });
  app.get('/admin/daemon-sessions/:id', { preHandler: app.requireAdmin }, (req) =>
    service.session(sessionId(req)),
  );
  app.post('/admin/daemon-sessions/:id/stop', { preHandler: app.requireAdmin }, async (req) => {
    const result = await service.stop(sessionId(req), undefined, undefined, `admin:${req.admin!.user.id}`);
    return result;
  });
  app.post('/admin/daemon-sessions/:id/messages', { preHandler: app.requireAdmin }, (req) => {
    const body = z
      .object({ prompt: z.string().trim().min(1).max(100_000), client_message_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    return service.turn(sessionId(req), body.prompt, body.client_message_id);
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/insecure-enable', async (req) => {
    const { session, host } = await messaging.authenticateBridge(
      (req.params as { sessionId: string }).sessionId,
      String(req.headers['x-agent-bridge-token'] ?? ''),
    );
    const body = z.object({
      host_id: z.number().int().positive(),
      duration_minutes: z.number().int().min(0).max(480).optional(),
    }).strict().parse(req.body);
    if (host.secure !== 1 || !session.agentBusAddressId)
      throw new ForbiddenError('An authenticated agent on a secure host is required', 'secure_host_required');
    const opened = ownerRuntimeFor(ctx.db)
      ? await new InsecureWindowAdminService({ db: ctx.db, env: ctx.env, events: makeAdminEventsWriter(ctx.db) }).enable(
        body.host_id, body.duration_minutes ?? null,
        { host_id: host.id, agent_address: `agent:${session.agentBusAddressId}`, session_id: session.id },
        snapshot => authorizeAgentInsecureEnable(snapshot, {
          sessionId: session.id, bridgeToken: String(req.headers['x-agent-bridge-token'] ?? ''),
          bindingGeneration: session.bindingGeneration, hostId: host.id,
          addressId: session.agentBusAddressId!, targetHostId: body.host_id,
        }),
      )
      : await ctx.db.transaction(async (tx) => {
      const locked = await tx.select().from(hosts)
        .where(inArray(hosts.id, [host.id, body.host_id])).orderBy(asc(hosts.id)).for('update');
      const caller = locked.find((h) => h.id === host.id), target = locked.find((h) => h.id === body.host_id);
      if (!caller || caller.secure !== 1 || caller.status !== 'active')
        throw new ForbiddenError('An active secure host is required', 'secure_host_required');
      if (!target || target.status !== 'active') throw new ForbiddenError('Target host is inactive');
      const db = tx as unknown as RouteContext['db'];
      const insecure = new InsecureWindowAdminService({ db, env: ctx.env, events: makeAdminEventsWriter(db) });
      return insecure.enable(body.host_id, body.duration_minutes ?? null, {
        host_id: host.id, agent_address: `agent:${session.agentBusAddressId}`, session_id: session.id,
      });
    });
    return { host_id: opened.id, enabled_until: opened.insecureEnabledUntil, window_minutes: opened.insecureWindowMinutes };
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/spawn', async (req) => {
    const actor = await owner(req);
    return service.start(daemonStartSchema.parse(req.body), actor);
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/spawn-status', async (req) => {
    const actor = await owner(req);
    const body = z.object({ session_id: z.string().uuid().optional() }).strict().parse(req.body);
    if (body.session_id) return service.session(body.session_id, actor);
    const hidden = await internalHostIds(ctx.db);
    const runtime=ownerRuntimeFor(ctx.db);runtime?.assertOwner();
    const rows = runtime?runtime.state.snapshot().daemons.all():await ctx.db.select().from(hostDaemons);
    return {
      hosts: await Promise.all(
        rows
          .filter((r) => r.settings.enabled && !hidden.includes(r.hostId))
          .map(async (r) => {
            const { sessions: _sessions, ...view } = await service.view(r.hostId);
            return view;
          }),
      ),
    };
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/stop', async (req) => {
    const actor = await owner(req);
    const body = z.object({ session_id: z.string().uuid() }).strict().parse(req.body);
    return service.stop(body.session_id, actor);
  });
  // Fleet Advisor: the caller is the authenticated agent session, never a host.
  const bridgeCaller = (req: FastifyRequest) =>
    messaging.authenticateBridge(
      (req.params as { sessionId: string }).sessionId,
      String(req.headers['x-agent-bridge-token'] ?? ''),
    );
  app.post('/host/agent-sessions/:sessionId/agent-messaging/advisor/ask', async (req, reply) => {
    const result = await advisor.ask(await bridgeCaller(req), req.body);
    reply.code(202);
    return result;
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/advisor/close', async (req) =>
    advisor.close(await bridgeCaller(req), req.body),
  );
  app.post('/host/agent-sessions/:sessionId/agent-messaging/advisor/status', async (req) =>
    advisor.status(await bridgeCaller(req), req.body),
  );
  app.post('/host/daemon/peer-finished', async (req) => {
    const host = await auth.authenticate(req);
    const body = z
      .object({ session_id: z.string().uuid(), message_id: z.string().uuid() })
      .strict()
      .parse(req.body);
    return service.peerFinished(host.id, body.session_id, body.message_id);
  });
  app.get('/host/daemon/config', async (req) => {
    const host = await auth.authenticate(req);
    const settings = (await service.settings(host.id)).settings;
    return {
      ...settings,
      enabled: daemonAccepting(settings),
      execution_requested: daemonExecutionEnabled(settings),
    };
  });
  app.post('/host/daemon/migration', async (req) => {
    const host = await auth.authenticate(req);
    const body = z
      .object({ request_id: z.string().uuid(), command: z.enum(['fence', 'status', 'release']) })
      .strict()
      .parse(req.body);
    return service.migration(host.id, body.request_id, body.command);
  });
  app.get(
    '/host/daemon/connect',
    {
      websocket: true,
      preValidation: async (req) => {
        await auth.authenticate(req);
      },
    },
    (socket, req) => attachHostDaemonSocket(socket, req, ctx),
  );
  if(ownerRuntimeFor(ctx.db)){
    startOwnerWorker(app,ctx.db,{name:'daemon-sweep',tables:['hostDaemons','hostDaemonSessions','hostDaemonOperations','agentPrompts','agentBusMessages'],select:(snapshot,now)=>daemonSweepObligations(snapshot,now,ctx.env.AGENT_PORTAL_RETENTION_HOURS),run:async work=>{await service.sweep(Number(work.key));},error:err=>app.log.warn({err},'daemon sweep failed')});
  } else {
  const timer = setInterval(() => {
    void ctx.db
      .select()
      .from(hostDaemons)
      .then(async (rows) => {
        for (const row of rows) {
          await service.sweep(row.hostId);
          service.changed(row.hostId);
        }
      })
      .catch((err) => app.log.warn({ err }, 'daemon sweep failed'));
    // Sweeps enforce 10-minute queue and hour-scale retention deadlines; every
    // 15 s they re-read every daemon's sessions for nothing (2026-10-23).
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
  }
}


export interface DaemonSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  on(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** Shared by the legacy WebSocket and the communicator multiplexed channel. */
export function attachHostDaemonSocket(socket: DaemonSocket, req: FastifyRequest, ctx: RouteContext) {
  const service = new HostDaemonService(ctx), auth = createHostAuthService(ctx);
  const runtime=ownerRuntimeFor(ctx.db);
  let guard:StreamAuthorization|undefined;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const authorize=async()=>{
    if(guard){guard.host();setOwnerRequestPrincipal({principal:`host:${guard.hostId}`,revalidate:snapshot=>{guard!.host(snapshot);}});return req.authHost!;}
    const host=await auth.authenticate(req);if(runtime)guard=new StreamAuthorization(runtime,host.id,host);return host;
  };

      let hostID = 0,
        generation = '',
        busy = false,
        closed = false;
      let chain = Promise.resolve();
      const send = (data: unknown) => {
        if (!closed) socket.send(JSON.stringify(data));
      };
      let pendingWake = false;
      const poll = () => {
        if (!generation || closed) return;
        if (busy) { pendingWake = true; return; }
        pendingWake = false;
        busy = true;
        void withOwnerRequestScope(async () => {
          // This peek authorizes nothing. Nonempty work still performs fresh
          // host authentication, daemon admission and the original locked offer.
          if (!await service.hasPendingOffer(hostID) || closed) return;
          const host = await authorize();
          const row = await service.settings(host.id);
          if (!row.settings.enabled || closed) return;
          const operation = await service.offer(hostID, generation);
          if (operation) send({ type: 'operation', operation });
        })
          .catch(() => {})
          .finally(() => {
            busy = false;
            if (pendingWake) poll();
          });
      };
      // Queue events are hints only; pending work still takes all durable fences.
      // Periodic reconciliation covers external writers and lost process events.
      const unsubscribe = wsPublisher.subscribe(({ type, payload }) => {
        if (type === 'host.daemon.operation.queued' && payload && typeof payload === 'object' &&
          'host_id' in payload && payload.host_id === hostID) poll();
      });
      // Queue events wake the poll at once; this only reconciles a lost event.
      const timer = runtime ? undefined : setInterval(poll, 60_000);
      let fingerprint='';
      const ownerChanged=()=>{
        if(closed||!runtime||!hostID)return;
        try {
          const authorized=guard?.host();clearTimeout(deadline);
          if(authorized?.deadline!=null){deadline=setTimeout(ownerChanged,Math.min(2147483647,Math.max(0,authorized.deadline-Date.now())));deadline.unref();}
          const snapshot=runtime.state.snapshot();
          const next=canonicalCommand(JSON.parse(JSON.stringify([
            snapshot.daemons.get(hostID)?.settings,
            snapshot.table('hostDaemonOperations').by('hostId',hostID).filter(o=>['queued','offered'].includes(o.status)).map(o=>[o.id,o.requestHash]),
            snapshot.table('hostDaemonSessions').by('hostId',hostID).map(s=>[s.id,s.status]),
            snapshot.hosts.get(hostID)?.engines,
          ])));
          if(next!==fingerprint){fingerprint=next;poll();}
        } catch {socket.close(1008,'Authorization changed');}
      };
      const stopOwner=runtime?.state.subscribe(ownerChanged);
      socket.on('message', (raw: { toString(): string }) => {
        chain = chain
          .then(() => withOwnerRequestScope(async () => {
            const msg = z
              .object({
                id: z.string().uuid(),
                type: z.string(),
                payload: z.object({}).catchall(z.unknown()).default({}),
              })
              .parse(JSON.parse(raw.toString()));
            try {
              const kill=runtime?{version:runtime.state.snapshot().setting('api_disabled')}:(await ctx.db.select().from(versions).where(eq(versions.name,'api_disabled')))[0];
              if (kill?.version === '1') {
                socket.close(1008, 'API disabled');
                return;
              }
              const host = await authorize();
              hostID = host.id;
              let result: unknown;
              if (msg.type === 'hello') {
                const body = z
                  .object({
                    instance_id: z.string().uuid(),
                    username: z.string(),
                    version: z.string().max(64),
                    engines: z.array(z.enum(['codex', 'claude', 'grok'])),
                    error: z.string().max(200).nullable().default(null),
                    // cxx 0.9.146+: per-session --permission-mode support.
                    permission_mode_version: z.number().int().min(0).max(1000).optional(),
                  })
                  .strict()
                  .parse(msg.payload);
                const connected = await service.connect(host.id, body);
                generation = connected.generation;
                result = connected;
                ownerChanged();
              } else {
                const current = await service.settings(host.id);
                if (!generation || current.runtime?.generation !== generation)
                  throw new ForbiddenError('Daemon connection superseded');
                if (msg.type === 'heartbeat') {
                  const body = z
                    .object({
                      engines: z.array(z.enum(['codex', 'claude', 'grok'])),
                      error: z.string().max(200).nullable().default(null),
                      active_sessions: z.array(z.string().uuid()).max(64).default([]),
                    })
                    .parse(msg.payload);
                  result = await service.heartbeat(host.id, generation, body.engines, body.error, body.active_sessions);
                } else if (msg.type === 'accept') {
                  result = await service.accept(
                    host.id,
                    z.string().uuid().parse(msg.payload.operation_id),
                    z.string().uuid().parse(msg.payload.claim_id),
                  );
                } else if (msg.type === 'complete') {
                  const body = z
                    .object({
                      operation_id: z.string().uuid(),
                      claim_id: z.string().uuid(),
                      result: z.object({
                        status: z.enum(['completed', 'failed', 'unknown', 'stopped']),
                        reply: z.string().max(100_000),
                        upstream_session_id: z.string().optional(),
                      }),
                    })
                    .parse(msg.payload);
                  result = await service.complete(host.id, body.operation_id, body.claim_id, body.result);
                } else throw new ForbiddenError('Unknown daemon operation');
              }
              send({ id: msg.id, result });
              // Acceptance frees the offered queue head; immediately fill the
              // next execution slot instead of waiting for the fallback tick.
              if (msg.type === 'hello' || msg.type === 'accept' || msg.type === 'complete') poll();
            } catch (err) {
              send({ id: msg.id, error: err instanceof Error ? err.message : 'Request rejected' });
            }
          }))
          .catch(() => {
            socket.close(1008, 'Invalid daemon frame');
          });
      });
      socket.on('close', () => {
        closed = true;
        clearInterval(timer);
        clearTimeout(deadline);
        stopOwner?.();
        unsubscribe();
        if (generation) void service.disconnect(hostID, generation).catch(() => {});
      });
}
