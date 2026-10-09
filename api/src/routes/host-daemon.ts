import { eq } from 'drizzle-orm';
import { registerWebsocketTransport } from '../ws/transport.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { hostDaemons, versions } from '../db/schema.js';
import { HostDaemonService } from '../services/host-daemon/service.js';
import { daemonSettingsSchema, daemonStartSchema } from '../services/host-daemon/policy.js';
import { createHostAuthService } from '../services/host-auth.js';
import { createAgentMessagingService } from '../services/agent-messaging.js';
import { createAdminEventsService } from '../services/admin-events.js';
import { ForbiddenError } from '../http/errors.js';

export async function registerHostDaemonRoutes(app: FastifyInstance, ctx: RouteContext) {
  await registerWebsocketTransport(app);
  const service = new HostDaemonService(ctx),
    auth = createHostAuthService(ctx);
  const messaging = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const events = createAdminEventsService(ctx.db);
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
    const rows = await ctx.db.select().from(hostDaemons);
    return { hosts: await Promise.all(rows.map((row) => service.view(row.hostId))) };
  });
  app.get('/admin/hosts/:id/daemon', { preHandler: app.requireAdmin }, (req) => service.view(hostId(req)));
  app.put('/admin/hosts/:id/daemon', { preHandler: app.requireAdmin }, async (req) => {
    const settings = daemonSettingsSchema.parse(req.body);
    const result = await service.configure(hostId(req), settings);
    await events.record({
      type: 'host.daemon.configured',
      payload: { host_id: hostId(req), settings, admin_user_id: req.admin!.user.id },
    });
    return result;
  });
  app.post('/admin/daemon-sessions', { preHandler: app.requireAdmin }, async (req, reply) => {
    const result = await service.start(daemonStartSchema.parse(req.body), `admin:${req.admin!.user.id}`);
    reply.code(202);
    return result;
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
  app.post('/host/agent-sessions/:sessionId/agent-messaging/spawn', async (req) => {
    const actor = await owner(req);
    return service.start(daemonStartSchema.parse(req.body), actor);
  });
  app.post('/host/agent-sessions/:sessionId/agent-messaging/spawn-status', async (req) => {
    const actor = await owner(req);
    const body = z.object({ session_id: z.string().uuid().optional() }).strict().parse(req.body);
    if (body.session_id) return service.session(body.session_id, actor);
    const rows = await ctx.db.select().from(hostDaemons);
    return {
      hosts: await Promise.all(
        rows
          .filter((r) => r.settings.enabled)
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
    return (await service.settings(host.id)).settings;
  });
  app.get(
    '/host/daemon/connect',
    {
      websocket: true,
      preValidation: async (req) => {
        await auth.authenticate(req);
      },
    },
    (socket, req) => {
      let hostID = 0,
        generation = '',
        busy = false,
        closed = false;
      let chain = Promise.resolve();
      const send = (data: unknown) => {
        if (!closed) socket.send(JSON.stringify(data));
      };
      const timer = setInterval(() => {
        if (!generation || busy || closed) return;
        busy = true;
        void (async () => {
          const host = await auth.authenticate(req);
          const row = await service.settings(host.id);
          if (!row.settings.enabled) return;
          const operation = await service.offer(hostID, generation);
          if (operation) send({ type: 'operation', operation });
        })()
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, 2000);
      socket.on('message', (raw: { toString(): string }) => {
        chain = chain
          .then(async () => {
            const msg = z
              .object({
                id: z.string().uuid(),
                type: z.string(),
                payload: z.object({}).catchall(z.unknown()).default({}),
              })
              .parse(JSON.parse(raw.toString()));
            try {
              const [kill] = await ctx.db.select().from(versions).where(eq(versions.name, 'api_disabled'));
              if (kill?.version === '1') {
                socket.close(1008, 'API disabled');
                return;
              }
              const host = await auth.authenticate(req);
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
                  })
                  .strict()
                  .parse(msg.payload);
                const connected = await service.connect(host.id, body);
                generation = connected.generation;
                result = connected;
              } else {
                const current = await service.settings(host.id);
                if (!generation || current.runtime?.generation !== generation)
                  throw new ForbiddenError('Daemon connection superseded');
                if (msg.type === 'heartbeat') {
                  const body = z
                    .object({
                      engines: z.array(z.enum(['codex', 'claude', 'grok'])),
                      error: z.string().max(200).nullable().default(null),
                    })
                    .parse(msg.payload);
                  result = await service.heartbeat(host.id, generation, body.engines, body.error);
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
            } catch (err) {
              send({ id: msg.id, error: err instanceof Error ? err.message : 'Request rejected' });
            }
          })
          .catch(() => {
            socket.close(1008, 'Invalid daemon frame');
          });
      });
      socket.on('close', () => {
        closed = true;
        clearInterval(timer);
        if (generation) void service.disconnect(hostID, generation).catch(() => {});
      });
    },
  );
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
  }, 15_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
}
