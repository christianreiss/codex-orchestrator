import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { createAgentMessagingService } from '../../../services/agent-messaging.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import type { RoleActor } from '../../../services/roles/contract.js';
import { createRolesService } from '../../agent-messaging/roles.js';

/**
 * Operator steering for agent roles. Agents improve roles on their own through
 * the proposal pipeline; these routes set policy, publish operator drafts,
 * revert, withdraw and decide held proposals — never a per-change approval queue.
 */
export async function registerAdminRoleRoutes(app: FastifyInstance, ctx: RouteContext) {
  const roles = createRolesService(ctx, createAgentMessagingService(ctx.db, ctx.env, ctx.keyring), app.log);
  const events = new AdminEventsService(ctx.db);
  const actor = (req: FastifyRequest): RoleActor => ({ kind: 'admin', admin_user_id: req.admin!.user.id });
  const slug = (req: FastifyRequest) => (req.params as { slug: string }).slug;
  const audit = (req: FastifyRequest, type: string, payload: Record<string, unknown>) =>
    events.record({ type, payload: { ...payload, admin_user_id: req.admin!.user.id } }, { broadcast: false });

  app.get('/admin/roles/state', { preHandler: app.requireAdmin }, async () => ({ enabled: await roles.isEnabled() }));
  app.post('/admin/roles/state', { preHandler: app.requireAdmin }, async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
    const result = await roles.setEnabled(enabled);
    await audit(req, 'agent_roles.state', { enabled });
    return result;
  });
  app.get('/admin/roles', { preHandler: app.requireAdmin }, () => roles.listAdmin());
  app.post('/admin/roles', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.createRole(req.body, actor(req));
    await audit(req, 'agent_roles.created', { slug: result.role.slug });
    return result;
  });
  app.get('/admin/roles/proposals/:id', { preHandler: app.requireAdmin }, (req) =>
    roles.proposalDetail(z.string().uuid().parse((req.params as { id: string }).id)),
  );
  app.post('/admin/roles/proposals/:id/decide', { preHandler: app.requireAdmin }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const result = await roles.decide(id, req.body, actor(req));
    await audit(req, 'agent_roles.proposal_decided', { proposal_id: id, verdict: (req.body as { verdict?: string })?.verdict ?? null });
    return result;
  });
  app.get('/admin/roles/:slug', { preHandler: app.requireAdmin }, (req) => roles.detailAdmin(slug(req)));
  app.patch('/admin/roles/:slug', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.updateRole(slug(req), req.body);
    await audit(req, 'agent_roles.updated', { slug: result.role.slug, fields: Object.keys((req.body as object) ?? {}) });
    return result;
  });
  app.get('/admin/roles/:slug/timeline', { preHandler: app.requireAdmin }, (req) => roles.timeline(slug(req)));
  app.get('/admin/roles/:slug/versions/:version', { preHandler: app.requireAdmin }, (req) =>
    roles.versionContent(slug(req), z.coerce.number().int().positive().parse((req.params as { version: string }).version)),
  );
  app.put('/admin/roles/:slug/draft', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.saveDraft(slug(req), req.body, actor(req));
    await audit(req, 'agent_roles.draft_saved', { slug: result.role.slug });
    return result;
  });
  app.delete('/admin/roles/:slug/draft', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.discardDraft(slug(req));
    await audit(req, 'agent_roles.draft_discarded', { slug: result.role.slug });
    return result;
  });
  app.post('/admin/roles/:slug/publish', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.publishDraft(slug(req), req.body, actor(req));
    await audit(req, 'agent_roles.published', { slug: result.role.slug, version: result.versions[0]?.version ?? null });
    return result;
  });
  app.post('/admin/roles/:slug/revert', { preHandler: app.requireAdmin }, async (req) => {
    const result = await roles.revert(slug(req), req.body, actor(req));
    await audit(req, 'agent_roles.reverted', { slug: result.role.slug, to: (req.body as { version?: number })?.version ?? null });
    return result;
  });
  app.post('/admin/roles/:slug/versions/:version/withdraw', { preHandler: app.requireAdmin }, async (req) => {
    const version = z.coerce.number().int().positive().parse((req.params as { version: string }).version);
    const result = await roles.withdraw(slug(req), version, req.body);
    await audit(req, 'agent_roles.withdrawn', { slug: result.role.slug, version });
    return result;
  });
}
