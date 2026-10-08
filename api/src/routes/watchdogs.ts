import type { FastifyInstance } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { WatchdogsService } from '../services/watchdogs.js';
import { createHostAuthService } from '../services/host-auth.js';
import { createInsecureWindowService } from '../services/insecure-window.js';
import { createSseLifecycle } from '../http/sse-lifecycle.js';
import { ForbiddenError } from '../http/errors.js';

export async function registerWatchdogRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new WatchdogsService(ctx.db, ctx.keyring);
  const trackStream = createSseLifecycle(app);
  const hostAuth = createHostAuthService({
    db: ctx.db,
    env: ctx.env,
    insecure: createInsecureWindowService({ db: ctx.db, env: ctx.env }),
  });
  app.post('/host/watchdogs/get', async (req) => {
    await hostAuth.authenticate(req);
    const v = z
      .object({ id: z.string().uuid().optional(), target: z.string().optional() })
      .strict()
      .parse(req.body);
    return v.id ? service.get(v.id) : service.list(v.target);
  });
  app.post('/host/watchdogs/enable', async (req) => {
    const host = await hostAuth.authenticate(req);
    return service.enable(req.body, `host:${host.id}`);
  });
  app.post('/host/watchdogs/disable', async (req) => {
    const host = await hostAuth.authenticate(req);
    return service.finish(req.body, `host:${host.id}`, true);
  });
  app.get('/admin/watchdogs', { preHandler: app.requireAdmin }, (req) =>
    service.list(z.object({ target: z.string().optional() }).parse(req.query).target),
  );
  app.get('/admin/watchdogs/:id', { preHandler: app.requireAdmin }, (req) =>
    service.get((req.params as { id: string }).id),
  );
  app.post('/admin/watchdogs', { preHandler: app.requireAdmin }, (req) =>
    service.enable(req.body, `admin:${req.admin!.user.id}`),
  );
  app.post('/admin/watchdogs/:id/disable', { preHandler: app.requireAdmin }, (req) =>
    service.finish(
      { ...(req.body as object), id: (req.params as { id: string }).id },
      `admin:${req.admin!.user.id}`,
      true,
    ),
  );
  const bridge = (req: { params: unknown; headers: Record<string, unknown> }) => ({
    id: z.object({ id: z.string().uuid() }).parse(req.params).id,
    token: z.string().min(1).parse(req.headers['x-agent-bridge-token']),
  });
  app.post('/host/agent-sessions/:id/watchdog/activity', async (req) => {
    const { id, token } = bridge(req);
    return service.activity(id, token, req.body);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/watchdog/get', async (req) => {
    const { id, token } = bridge(req),
      session = await service.bridge(id, token);
    const input = z.object({ id: z.string().uuid().optional() }).strict().parse(req.body);
    if (!input.id) return service.snapshot(id, token);
    const watchdog = await service.get(input.id);
    if (watchdog.target !== `agent:${session.agentBusAddressId}`)
      throw new ForbiddenError('Watchdog belongs to another agent');
    return watchdog;
  });
  app.post('/host/agent-sessions/:id/agent-messaging/watchdog/enable', async (req) => {
    const { id, token } = bridge(req),
      session = await service.bridge(id, token);
    const input = z
      .object({
        task_key: z.string(),
        continuation: z.string(),
        duration_seconds: z.number().optional(),
        progress_timeout_seconds: z.number().optional(),
        version: z.number().optional(),
      })
      .strict()
      .parse(req.body);
    return service.enable({ ...input, target: `agent:${session.agentBusAddressId}` }, `session:${id}`, id);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/watchdog/disable', async (req) => {
    const { id, token } = bridge(req);
    await service.bridge(id, token);
    return service.finish(req.body, `session:${id}`, true, id);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/watchdog/finish', async (req) => {
    const { id, token } = bridge(req);
    await service.bridge(id, token);
    return service.finish(req.body, `session:${id}`, false, id);
  });
  app.get('/host/agent-sessions/:id/watchdog/stream', async (req, reply) => {
    const { id, token } = bridge(req);
    // Authenticate before hijacking, and re-authorize every frame.
    await service.snapshot(id, token);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();
    const controller = new AbortController();
    const close = () => controller.abort();
    const stopStream = trackStream(reply, close);
    try {
      while (!controller.signal.aborted) {
        const snapshot = await service.snapshot(id, token);
        if (controller.signal.aborted) break;
        if (!reply.raw.write(`event: watchdog\ndata: ${JSON.stringify(snapshot)}\n\n`)) break;
        await delay(15000, undefined, { signal: controller.signal }).catch(() => {});
      }
    } catch {
      /* Revocation or outage closes the feed; reconnect requires fresh auth. */
    } finally {
      stopStream();
    }
  });
}
