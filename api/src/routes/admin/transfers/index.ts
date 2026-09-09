import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { AgentTransfersService } from '../../../services/agent-transfers.js';
import { SettingsService } from '../../../services/settings.js';
import { adminSpaHtmlPreHandler } from '../pages/static.js';

/**
 * Admin surface for the file transfer pool.
 *
 * Read is a live view of what agents are currently moving around: every held
 * file, its size and type, who claims to have uploaded it, how many times it
 * has been fetched and when it expires. The audit trail behind each row is the
 * point of the page — the pool has no addressing, so knowing an id is
 * sufficient to fetch, and what that owes an operator instead is a record of
 * who actually took a copy.
 *
 * `/content` is deliberately a capability of its own rather than part of the
 * listing. The same line `secrets.reveal` draws: metadata about a file is not
 * the file, and an agent payload may hold anything the fleet was working on.
 */

const stateSchema = z.object({
  enabled: z.union([z.boolean(), z.literal(0), z.literal(1), z.enum(['0', '1', 'true', 'false'])]),
});

const limitsSchema = z
  .object({
    default_ttl_seconds: z.number().int().positive().optional(),
    max_ttl_seconds: z.number().int().positive().optional(),
    max_file_bytes: z.number().int().positive().optional(),
    quota_bytes: z.number().int().positive().optional(),
  })
  .strict();

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

function idFrom(req: FastifyRequest): string {
  return String((req.params as { id?: unknown }).id ?? '').trim();
}

/**
 * `Content-Disposition` for a name the uploading agent chose. The ASCII
 * `filename` is sanitized down to something every browser accepts, and the
 * RFC 5987 `filename*` carries the real one — a transfer named in Japanese
 * should not arrive as a row of underscores just because the fallback cannot
 * spell it.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function registerAdminTransfersRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const transfers = new AgentTransfersService({
    db: ctx.db,
    settings: new SettingsService(ctx.db),
    dataRoot: ctx.env.DATA_ROOT ?? '/app/storage',
  });
  const events = new AdminEventsService(ctx.db);
  const adminSpa = adminSpaHtmlPreHandler(ctx);

  app.get('/admin/transfers/state', { preHandler: app.requireAdmin }, async () => {
    return await transfers.adminState();
  });

  app.post('/admin/transfers/state', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = stateSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const raw = parsed.data.enabled;
    const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
    const state = await transfers.setEnabled(enabled);
    await events.record({
      type: 'transfers.module_toggled',
      payload: { enabled, admin_user_id: actor(req) },
    });
    return state;
  });

  app.post('/admin/transfers/limits', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = limitsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const state = await transfers.setLimits(parsed.data);
    await events.record({
      type: 'transfers.limits_changed',
      payload: { ...parsed.data, admin_user_id: actor(req) },
    });
    return state;
  });

  // Shares its URL with the client route, so the Accept-sniffing preHandler
  // decides whether this answers JSON or serves the SPA shell.
  app.get('/admin/transfers', { preHandler: [adminSpa, app.requireAdmin] }, async (req) => {
    const includeRetired = (req.query as { include_retired?: unknown })?.include_retired === '1';
    return { transfers: await transfers.list({ includeRetired, limit: 200 }) };
  });

  app.get('/admin/transfers/:id/events', { preHandler: app.requireAdmin }, async (req) => {
    return { events: await transfers.events(idFrom(req)) };
  });

  app.get(
    '/admin/transfers/:id/content',
    { preHandler: app.requireAdmin },
    async (req, reply: FastifyReply) => {
      const { transfer, stream } = await transfers.openDownload(idFrom(req), {
        kind: 'admin',
        label: actor(req) === null ? null : String(actor(req)),
      });
      // `broadcast: false`: an operator reading a file is an audit fact, not a
      // change to anything the console is showing.
      await events.record(
        {
          type: 'transfers.downloaded',
          payload: { transfer_id: transfer.id, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      // Not the envelope plugin's JSON shape: this reply IS the file.
      return reply
        .header('Content-Type', transfer.mime_type ?? 'application/octet-stream')
        .header('Content-Length', String(transfer.size_bytes))
        .header('Content-Disposition', contentDisposition(transfer.name))
        .header('X-Content-Type-Options', 'nosniff')
        .send(stream);
    },
  );

  app.delete('/admin/transfers/:id', { preHandler: app.requireAdmin }, async (req) => {
    const id = idFrom(req);
    const removed = await transfers.remove(id, {
      kind: 'admin',
      label: actor(req) === null ? null : String(actor(req)),
    });
    await events.record({
      type: 'transfers.deleted',
      payload: { transfer_id: id, admin_user_id: actor(req) },
    });
    return removed;
  });
}
