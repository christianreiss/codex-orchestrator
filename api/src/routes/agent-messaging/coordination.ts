import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { AgentCoordination } from '../../services/agent-coordination/index.js';
import { createAdminEventsService } from '../../services/admin-events.js';

export function registerCoordinationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  messaging: AgentMessagingService,
) {
  const service = new AgentCoordination(ctx.db, ctx.env, ctx.keyring, messaging);
  const audit = createAdminEventsService(ctx.db);
  const bridge = (req: FastifyRequest) => {
    const token = req.headers['x-agent-bridge-token'];
    if (typeof token !== 'string' || !token) throw new UnauthorizedError('Bridge credential required');
    return {
      id: z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id),
      token,
    };
  };
  const operations: Record<string, (id: string, token: string, body: unknown) => Promise<unknown>> = {
    'context/get': (id, token) => service.context(id, token),
    'context/update': (id, token, body) => service.update(id, token, body),
    'rooms/list': (id, token) => service.context(id, token),
    'rooms/read': (id, token, body) => service.read(id, token, body),
    'rooms/send': (id, token, body) => service.send(id, token, body),
    'claims/acquire': (id, token, body) => service.claims.acquire(id, token, body),
    'claims/status': (id, token, body) => service.claims.status(id, token, body),
    'claims/release': (id, token, body) => service.claims.release(id, token, body),
  };
  const invoke = (path: string, req: FastifyRequest) => {
    const { id, token } = bridge(req);
    return operations[path]!(id, token, req.body ?? {});
  };
  app.post('/host/agent-sessions/:id/agent-messaging/context/get', (req) => invoke('context/get', req));
  app.post('/host/agent-sessions/:id/agent-messaging/context/update', (req) => invoke('context/update', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/list', (req) => invoke('rooms/list', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/read', (req) => invoke('rooms/read', req));
  app.post('/host/agent-sessions/:id/agent-messaging/rooms/send', (req) => invoke('rooms/send', req));
  app.post('/host/agent-sessions/:id/agent-messaging/claims/acquire', (req) => invoke('claims/acquire', req));
  app.post('/host/agent-sessions/:id/agent-messaging/claims/status', (req) => invoke('claims/status', req));
  app.post('/host/agent-sessions/:id/agent-messaging/claims/release', (req) => invoke('claims/release', req));
  app.get('/admin/agent-messaging/scopes/state', { preHandler: app.requireAdmin }, () => service.state());
  app.post('/admin/agent-messaging/scopes/state', { preHandler: app.requireAdmin }, async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    return service.setEnabled(enabled, req.admin!.user.id);
  });
  app.get('/admin/agent-messaging/scopes', { preHandler: app.requireAdmin }, async () =>
    (await messaging.isEnabled())
      ? service.context(null, null)
      : { enabled: false, rooms: [], claims: [], reason: 'messaging_disabled' },
  );
  app.get('/admin/agent-messaging/scopes/:scopeId/members', { preHandler: app.requireAdmin }, (req) =>
    service.memberPage(
      z
        .string()
        .uuid()
        .parse((req.params as { scopeId: string }).scopeId),
      z.coerce
        .number()
        .int()
        .nonnegative()
        .default(0)
        .parse((req.query as { offset?: string }).offset),
    ),
  );
  app.post('/admin/agent-messaging/scopes/read', { preHandler: app.requireAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const result = await service.read(null, null, req.body);
    await audit.record(
      {
        type: 'agent_coordination.revealed',
        payload: { scope_id: result.scope.id, admin_user_id: req.admin!.user.id },
      },
      { broadcast: false },
    );
    return result;
  });
  app.post('/admin/agent-messaging/scopes/send', { preHandler: app.requireAdmin }, (req) =>
    service.send(null, null, req.body, { id: req.admin!.user.id, name: req.admin!.user.name }),
  );
  app.post('/admin/agent-messaging/scopes/resolve', { preHandler: app.requireAdmin }, async (req) => {
    const result = await service.claims.release(null, null, req.body, req.admin!.user.id);
    await audit.record(
      {
        type: 'agent_coordination.resolved',
        payload: {
          claim_id: result.id,
          admin_user_id: req.admin!.user.id,
          outcome: (req.body as { outcome: string }).outcome,
          reason: (req.body as { reason: string }).reason,
        },
      },
      { broadcast: false },
    );
    return result;
  });
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = service
      .tick()
      .catch((error) => app.log.error({ err: error }, 'Scope coordination tick failed'))
      .finally(() => {
        running = undefined;
      });
  }, 2000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
