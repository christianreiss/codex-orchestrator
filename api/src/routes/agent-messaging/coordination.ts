import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { UnauthorizedError } from '../../http/errors.js';
import type { AgentMessagingService } from '../../services/agent-messaging.js';
import { AgentCoordination } from '../../services/agent-coordination/index.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import { wsPublisher } from '../../ws/publisher.js';

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
  // Reconciliation follows the events that change its input. The fallback only
  // catches time-based transitions: presence freshness, claim expiry, and the
  // 2 s dispatch delay of a scope event that nobody announced. A blind 2 s
  // interval cost one ~6,000-row input snapshot every tick (2026-10-23).
  let running: Promise<void> | undefined;
  let again = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (running) {
      again = true;
      return;
    }
    running = service
      .tick()
      .catch((error) => app.log.error({ err: error }, 'Scope coordination tick failed'))
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          schedule();
        }
      });
  };
  const schedule = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = undefined;
      run();
    }, COORDINATION_EVENT_DELAY_MS);
    soon.unref();
  };
  const unsubscribe = wsPublisher.subscribe(({ type }) => {
    if (COORDINATION_INPUT_EVENTS.test(type)) schedule();
  });
  const timer = setInterval(run, COORDINATION_FALLBACK_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    unsubscribe();
    clearInterval(timer);
    if (soon) clearTimeout(soon);
    await running;
  });
}

/** Just past the 2 s scope-event dispatch delay, so one tick sees the new event as due. */
const COORDINATION_EVENT_DELAY_MS = 2100;
const COORDINATION_FALLBACK_MS = 10_000;
const COORDINATION_INPUT_EVENTS =
  /^(agent_portal\.sessions\.|agent_coordination\.|agent_messaging\.(address|state|host|relay)\.|host\.(?!daemon\.)|settings\.|engine\.|auth\.invalidated|apikey\.|project\.)/;
