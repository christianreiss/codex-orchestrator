import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { HostProjectsService } from '../../../services/host-projects.js';
import { ProjectBoardService } from '../../../services/project-board.js';
import { PROJECT_BOARD_ROLES } from '../../../services/project-board-roles.js';
import { SettingsService } from '../../../services/settings.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

/**
 * Admin surface for the project board.
 *
 * The module switch lives at `/admin/project-board/state` rather than under
 * `/admin/projects/…`, which would have made `board` a project slug: the
 * existing tree already routes `/admin/projects/:slug`, and a project called
 * "board" would shadow the switch or the switch would shadow the project.
 * Per-project routes hang off `/admin/projects/:slug/board`, where they cannot
 * collide with anything.
 *
 * There is no column create or delete. Migration 0026 seeds seven lanes and
 * `POST …/columns/:id` reshapes them; deleting one would have to answer what
 * happens to the cards in it, which is a product question rather than a
 * plumbing one, and it is not one an operator should answer by accident.
 */

const stateSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.enum(['0', '1', 'true', 'false'])]),
});

const createCardSchema = z.object({
  title: z.string().trim().min(1).max(255),
  detail: z.string().max(32000).optional(),
  column: z.string().trim().min(1).optional(),
  labels: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  priority: z.number().int().optional(),
});

const updateCardSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  detail: z.string().max(32000).optional(),
  labels: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  priority: z.number().int().optional(),
  blocked_reason: z.string().max(500).nullable().optional(),
});

const moveCardSchema = z.object({
  column: z.string().trim().min(1),
  note: z.string().max(1000).optional(),
});

const releaseCardSchema = z.object({
  reason: z.string().trim().max(255).optional().nullable(),
});

const updateColumnSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  wip_limit: z.number().int().min(0).nullable().optional(),
  allowed_roles: z.array(z.enum(PROJECT_BOARD_ROLES)).nullable().optional(),
  position: z.number().int().min(0).optional(),
  default_next_column_id: z.string().trim().nullable().optional(),
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

function slugOf(req: FastifyRequest): string {
  return decodeURIComponent(String((req.params as { slug?: unknown }).slug ?? ''));
}

function idOf(req: FastifyRequest): string {
  return String((req.params as { id?: unknown }).id ?? '').trim();
}

export async function registerAdminProjectBoardRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const board = new ProjectBoardService({
    db: ctx.db,
    projects: new HostProjectsService(ctx.db),
    settings: new SettingsService(ctx.db),
  });
  const events = new AdminEventsService(ctx.db);
  const adminSpa = adminSpaHtmlPreHandler(ctx);

  app.get('/admin/project-board/state', { preHandler: app.requireAdmin }, async () => {
    return await board.adminState();
  });

  app.post('/admin/project-board/state', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = stateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const raw = parsed.data.enabled;
    const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
    const state = await board.setEnabled(enabled);
    await events.record({
      type: 'project_board.module_toggled',
      payload: { enabled, admin_user_id: actor(req) },
    });
    return state;
  });

  // Shares its URL with the SPA's board page, so the Accept-sniffing preHandler
  // decides whether this answers JSON or serves the shell.
  app.get('/admin/projects/:slug/board', { preHandler: [adminSpa, app.requireAdmin] }, async (req) => {
    return await board.adminBoard(slugOf(req));
  });

  app.post('/admin/projects/:slug/board/cards', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = createCardSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    // No host: a card made from the console is the operator's, and attributing
    // it to a host that did not create it would be a lie in the event log.
    return await board.createCard({ slug: slugOf(req), ...parsed.data }, null);
  });

  app.post('/admin/projects/:slug/board/cards/:id', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = updateCardSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    return await board.updateCard({ slug: slugOf(req), card: idOf(req), ...parsed.data }, null);
  });

  app.post('/admin/projects/:slug/board/cards/:id/move', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = moveCardSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    return await board.moveCard({ slug: slugOf(req), card: idOf(req), ...parsed.data }, null);
  });

  /**
   * Take a claim back on the operator's behalf. This is the escape hatch for a
   * holder that is unreachable but not detectably dead — a wedged process, a
   * laptop asleep — which neither reclaim signal will catch on its own.
   */
  app.post('/admin/projects/:slug/board/cards/:id/release', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = releaseCardSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const result = await board.adminForceRelease(slugOf(req), idOf(req), parsed.data.reason ?? null);
    await events.record({
      type: 'project_board.claim_force_released',
      payload: { slug: slugOf(req), card: idOf(req), admin_user_id: actor(req) },
    });
    return result;
  });

  app.delete('/admin/projects/:slug/board/cards/:id', { preHandler: app.requireAdmin }, async (req) => {
    return await board.archiveCard({ slug: slugOf(req), card: idOf(req) }, null);
  });

  app.post('/admin/projects/:slug/board/columns/:id', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = updateColumnSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    return await board.adminUpdateColumn(slugOf(req), idOf(req), parsed.data);
  });
}
