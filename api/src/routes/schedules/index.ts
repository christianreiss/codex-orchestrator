import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { SchedulesService } from '../../services/schedules.js';
import { adminSpaHtmlPreHandler } from '../admin/pages/static.js';

export async function registerScheduleRoutes(app: FastifyInstance, ctx: RouteContext) {
  const service = new SchedulesService(ctx.db, ctx.keyring);
  app.get('/admin/schedules', { preHandler: [adminSpaHtmlPreHandler(ctx), app.requireAdmin] }, (req) =>
    service.list((req.query ?? {}) as Record<string, unknown>),
  );
  app.get('/admin/schedules/:id', { preHandler: app.requireAdmin }, (req) =>
    service.get((req.params as { id: string }).id),
  );
  app.post('/admin/schedules', { preHandler: app.requireAdmin }, (req) =>
    service.create(req.body, `admin:${req.admin!.user.id}`),
  );
  app.patch('/admin/schedules/:id', { preHandler: app.requireAdmin }, (req) =>
    service.update(
      { ...(req.body as Record<string, unknown>), id: (req.params as { id: string }).id },
      `admin:${req.admin!.user.id}`,
    ),
  );
  app.delete('/admin/schedules/:id', { preHandler: app.requireAdmin }, (req) => {
    const body = z.object({ version: z.number().int().positive() }).strict().parse(req.body);
    return service.remove({ ...body, id: (req.params as { id: string }).id }, `admin:${req.admin!.user.id}`);
  });
  app.post('/host/agent-sessions/:id/schedule-policy', async (req) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    const token = z.string().min(1).parse(req.headers['x-agent-bridge-token']);
    return service.sessionPolicy(id, token);
  });
}
