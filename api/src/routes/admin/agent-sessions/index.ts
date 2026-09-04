import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError } from '../../../http/errors.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { createAgentPortalService } from '../../../services/agent-portal.js';
import { emptyWork, loadSessionWork, type SessionWorkInput } from '../../../services/agent-session-work.js';

/**
 * The console's view of the fleet's live agent sessions.
 *
 * This mirrors the read half of `/go/api/*` onto the admin session cookie. The
 * projection itself is not duplicated: `AgentPortalService.listAgents()` already
 * derives presence honestly from heartbeat freshness, and re-deriving it here is
 * exactly the drift `services/agent-presence.ts` was written to end. What the
 * console adds is the work context — the Git Director task and the Agent
 * Messaging address — which the portal has no reason to show a phone.
 *
 * The write half deliberately stops at force-close. Every other operator write
 * inserts into `agent_messages`, whose `portal_user_id` is NOT NULL and also
 * carries the message idempotency identity, so an admin cannot author one
 * without a schema change. Force writes an event and a terminal state and no
 * queue row, which is why it is reachable here — and it is the action an
 * operator actually needs from a console, because it is the only one that works
 * on the offline session a cooperative close can never reach.
 *
 * Liveness on this surface is SSE plus polling, and bypasses the WS
 * invalidation map on purpose: nothing publishes a WS event when a session
 * registers, heartbeats or appends an event, and emitting one per wrapper per
 * 15 seconds would be traffic no one reads. The single force-close event is the
 * exception, and it is in the map.
 */

/** Portal retention keeps ended sessions readable, so the feed is never empty by design. */
const EVENT_PAGE_MAX = 500;

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

function stringParam(params: unknown, key: string): string {
  return String((params as Record<string, unknown> | undefined)?.[key] ?? '').trim();
}

/** The admin's own name is what the agent's timeline shows as the author. */
function actorName(req: FastifyRequest): string {
  const user = req.admin?.user;
  return user?.name?.trim() || user?.username?.trim() || 'Console operator';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const forceSchema = z.object({
  client_message_id: z.string(),
  note: z.string().max(4000).optional(),
});

export async function registerAdminAgentSessionsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const events = new AdminEventsService(ctx.db);

  app.get('/admin/agent-sessions', { preHandler: app.requireAdmin }, async () => {
    // `enabled` travels with the rows because an empty list has two very
    // different meanings: nobody is running, or the module is off and
    // `registerAgent` has been discarding every registration. The page cannot
    // tell those apart from the rows alone, and the second one reads as a bug.
    const [enabled, sessions] = await Promise.all([portal.isEnabled(), portal.listAgents()]);
    const inputs = sessions.map((session) => ({
      id: String(session.id),
      host_id: Number(session.host_id),
      cwd: String(session.cwd ?? ''),
    })) satisfies SessionWorkInput[];
    const work = await loadSessionWork(ctx.db, inputs);
    return {
      enabled,
      timings: portal.timings(),
      sessions: sessions.map((session) => ({
        ...session,
        work: work.get(String(session.id)) ?? emptyWork(),
      })),
    };
  });

  app.get(
    '/admin/agent-sessions/events',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const query = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query ?? {});
      const rawHeaderCursor = req.headers['last-event-id'];
      const headerCursor = Number(Array.isArray(rawHeaderCursor) ? rawHeaderCursor[0] : rawHeaderCursor);
      let cursor =
        query.after ??
        (rawHeaderCursor !== undefined && Number.isFinite(headerCursor)
          ? Math.max(0, Math.trunc(headerCursor))
          : await portal.latestEventCursor());
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Referrer-Policy': 'no-referrer',
      });
      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      let lastHeartbeat = Date.now();
      while (!closed && !reply.raw.destroyed) {
        try {
          const page = await portal.listEventsAfter(cursor, 250);
          for (const event of page.events) {
            cursor = Number(event.cursor ?? cursor);
            if (!reply.raw.write(`id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`)) {
              // A stalled reader must reconnect with Last-Event-ID rather than
              // growing an unbounded server-side buffer behind it.
              closed = true;
              break;
            }
          }
          if (!closed && Date.now() - lastHeartbeat >= 15_000) {
            if (!reply.raw.write(`: heartbeat ${Date.now()}\n\n`)) closed = true;
            lastHeartbeat = Date.now();
          }
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'stream_error';
          reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({ code })}\n\n`);
          break;
        }
        await delay(1000);
      }
      reply.raw.end();
    },
  );

  app.get('/admin/agent-sessions/:id/events', { preHandler: app.requireAdmin }, async (req) => {
    const query = z
      .object({
        after: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(EVENT_PAGE_MAX).optional(),
        tail: z.coerce.boolean().optional(),
      })
      .parse(req.query ?? {});
    return await portal.listEvents(
      stringParam(req.params, 'id'),
      query.after ?? 0,
      query.limit ?? 250,
      query.tail ?? false,
    );
  });

  app.post('/admin/agent-sessions/:id/close/force', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = forceSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const sessionId = stringParam(req.params, 'id');
    const result = await portal.forceClose(
      { kind: 'admin', displayName: actorName(req) },
      { sessionId, clientMessageId: parsed.data.client_message_id, note: parsed.data.note },
    );
    // Recorded even when `forced` is false: a second Force on an already-ended
    // session is a no-op to the agent but still an operator action, and the
    // audit trail is the only place that distinguishes "ended by itself" from
    // "an admin reached for the switch twice".
    await events.record({
      type: 'agent_portal.session.force_closed',
      payload: {
        session_id: sessionId,
        forced: result.forced === true,
        admin_user_id: req.admin?.user?.id ?? null,
      },
    });
    return result;
  });
}
