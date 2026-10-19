import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { FeedbackService } from '../../../services/feedback.js';
import { parseFeedback, type FeedbackActor } from '../../../services/feedback-contract.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

export async function registerAdminFeedbackRoutes(app: FastifyInstance, ctx: RouteContext) {
  const feedback = new FeedbackService(ctx.db, ctx.keyring);
  const events = new AdminEventsService(ctx.db);
  const actor = (req: FastifyRequest): FeedbackActor => ({ host_id: null, engine: null, admin_user_id: req.admin!.user.id });
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  app.get('/admin/feedback/state', { preHandler: app.requireAdmin }, async () => ({ enabled: await feedback.getEnabled() }));
  app.post('/admin/feedback/state', { preHandler: app.requireAdmin }, async (req) => {
    const { enabled } = parseFeedback(z.object({ enabled: z.boolean() }).strict(), req.body);
    const state = await feedback.setEnabled(enabled);
    await events.record({ type: 'feedback.changed', payload: { enabled, admin_user_id: req.admin!.user.id } });
    return state;
  });
  app.get('/admin/feedback/summary', { preHandler: app.requireAdmin }, (req) => feedback.summary(actor(req)));
  app.get('/admin/feedback', { preHandler: [adminSpaHtmlPreHandler(ctx), app.requireAdmin] }, (req) => feedback.list(req.query, actor(req)));
  app.post('/admin/feedback', { preHandler: app.requireAdmin }, (req) => feedback.submit(req.body, actor(req)));
  app.get('/admin/feedback/:id', { preHandler: app.requireAdmin }, (req) => feedback.get(id(req), actor(req)));
  app.post('/admin/feedback/:id', { preHandler: app.requireAdmin }, (req) => feedback.update({ ...(req.body as object), id: id(req) }, actor(req)));
  // Destructive, audited (admin_events feedback.deleted / feedback.purged inside the same transaction).
  app.post('/admin/feedback/purge', { preHandler: app.requireAdmin }, (req) => feedback.purge(req.body ?? {}, actor(req)));
  app.delete('/admin/feedback/:id', { preHandler: app.requireAdmin }, (req) => feedback.remove(id(req), actor(req)));
  app.post('/admin/feedback/:id/claim', { preHandler: app.requireAdmin }, (req) => feedback.claim({ ...(req.body as object), id: id(req) }, actor(req)));
}
