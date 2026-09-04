import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { GitDirectorService } from '../../../services/git-director.js';
import { SettingsService } from '../../../services/settings.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

/**
 * Admin surface for the Git Director.
 *
 * Read is a live view of the registry: clones on each host, the worktrees in
 * each, the current lease and queue per branch, and recent verdicts with the
 * reason each carried. That last part is the point of the page — a contended
 * verdict may come from a model and is not reproducible, so the console is where
 * a human can see WHY a merge was told to wait.
 *
 * The service is constructed here without a judge. Nothing on this route decides
 * a contended merge: the toggle and the listing never arbitrate, and
 * `POST /requests/:id/decide` is an operator overriding the arbiter rather than
 * consulting it. Leaving the judge out makes that structural rather than a
 * convention.
 */

const stateSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.enum(['0', '1', 'true', 'false'])]),
});

const decideSchema = z.object({
  verdict: z.enum(['allow', 'deny']),
  reason: z.string().trim().max(1000).optional().nullable(),
});

function badRequest(issue: { message?: string; path?: (string | number)[] } | undefined): ApiError {
  const param = issue?.path?.length ? issue.path.join('.') : undefined;
  const message = issue?.message ?? 'Invalid request body';
  return new ApiError(param ? `${param}: ${message}` : message, {
    status: 400,
    code: 'invalid_request',
    type: 'invalid_request_error',
    param,
    extra: param ? { param } : undefined,
  });
}

function actor(req: FastifyRequest): number | null {
  return req.admin?.user?.id ?? null;
}

export async function registerAdminGitDirectorRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const director = new GitDirectorService({
    db: ctx.db,
    settings: new SettingsService(ctx.db),
    freshSeconds: ctx.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
  });
  const events = new AdminEventsService(ctx.db);
  const adminSpa = adminSpaHtmlPreHandler(ctx);

  app.get('/admin/git-director/state', { preHandler: app.requireAdmin }, async () => {
    return await director.adminState();
  });

  app.post('/admin/git-director/state', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = stateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const raw = parsed.data.enabled;
    const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
    const state = await director.setEnabled(enabled);
    await events.record({
      type: 'git_director.module_toggled',
      payload: { enabled, admin_user_id: actor(req) },
    });
    return state;
  });

  // Shares its URL with the client route, so the Accept-sniffing preHandler
  // decides whether this answers JSON or serves the SPA shell.
  app.get('/admin/git-director', { preHandler: [adminSpa, app.requireAdmin] }, async () => {
    return { clones: await director.adminClones() };
  });

  app.post('/admin/git-director/worktrees/:id/release', { preHandler: app.requireAdmin }, async (req) => {
    const id = String((req.params as { id?: unknown }).id ?? '').trim();
    const result = await director.adminEvictWorktree(id);
    await events.record({
      type: 'git_director.worktree_evicted',
      payload: { worktree_id: id, admin_user_id: actor(req) },
    });
    return result;
  });

  app.post('/admin/git-director/requests/:id/decide', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = decideSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const id = String((req.params as { id?: unknown }).id ?? '').trim();
    const result = await director.adminDecide(id, parsed.data.verdict, parsed.data.reason ?? null);
    await events.record({
      type: 'git_director.decision_forced',
      payload: { request_id: id, verdict: parsed.data.verdict, admin_user_id: actor(req) },
    });
    return result;
  });
}
