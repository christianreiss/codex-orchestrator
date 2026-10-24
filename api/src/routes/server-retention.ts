import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { retentionStatus, saveRetentionPolicy, previewRetention, requestRetentionRun, retentionRun } from '../services/server-retention/admin.js';

export async function registerServerRetentionRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get('/admin/server-retention', { preHandler: app.requireAdmin }, async () => retentionStatus(ctx.db));
  app.post('/admin/server-retention', { preHandler: app.requireAdmin }, async req => saveRetentionPolicy(ctx.db, req.body));
  app.post('/admin/server-retention/preview', { preHandler: app.requireAdmin }, async () => previewRetention(ctx.db));
  app.post('/admin/server-retention/run', { preHandler: app.requireAdmin }, async (req, reply) => reply.code(202).send(await requestRetentionRun(ctx.db, req.body)));
  app.get<{ Params: { id: string } }>('/admin/server-retention/runs/:id', { preHandler: app.requireAdmin }, async req => retentionRun(ctx.db, req.params.id));
}
