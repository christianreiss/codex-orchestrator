import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../../index.js';
import { ApiError, ServiceUnavailableError, UnauthorizedError } from '../../../http/errors.js';
import { AdminAuthService } from '../../../services/admin-auth.js';
import { AdminEventsService } from '../../../services/admin-events.js';
import { createAgentPortalService, type PortalActor } from '../../../services/agent-portal.js';
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
 * Cooperative messages, prompt answers and close requests share the portal's
 * durable queue; force-close remains available when the wrapper is unreachable.
 * SSE carries transcript events, while snapshot polling and metadata-only WS
 * invalidations keep derived presence current.
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

/**
 * The console operator as a message author.
 *
 * The id reaches `agent_messages.admin_user_id`, so revoking the account kills
 * anything it queued; the name is what the agent's own timeline shows.
 * `requireAdmin` has already resolved the session, and the service re-reads the
 * row under its write lock rather than trusting this.
 */
function adminActor(req: FastifyRequest): PortalActor {
  const user = req.admin?.user;
  if (!user) throw new ApiError('Admin session required', { status: 401, code: 'admin_required', type: 'invalid_request_error' });
  return {
    kind: 'admin',
    user: { id: user.id, displayName: user.name?.trim() || user.username?.trim() || 'Console operator' },
  };
}

const forceSchema = z.object({
  client_message_id: z.string(),
  note: z.string().max(4000).optional(),
});

const messageSchema = z.object({
  client_message_id: z.string(),
  content: z.string(),
});

const answerSchema = z.object({
  client_message_id: z.string(),
  answer: z.string(),
  version: z.number().int().positive().optional(),
});

export async function registerAdminAgentSessionsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const events = new AdminEventsService(ctx.db);
  const auth = new AdminAuthService(ctx.db, ctx.env);

  app.get('/admin/agent-sessions', { preHandler: app.requireAdmin }, async () => {
    // `enabled` travels with the rows because an empty list has two very
    // different meanings: nobody is running, or the module is off and
    // `registerAgent` has been discarding every registration. The page cannot
    // tell those apart from the rows alone, and the second one reads as a bug.
    const [enabled, snapshot] = await Promise.all([portal.isEnabled(), portal.listAgentsSnapshot()]);
    const { sessions } = snapshot;
    const inputs = sessions.map((session) => ({
      id: String(session.id),
      host_id: Number(session.host_id),
      cwd: String(session.cwd ?? ''),
    })) satisfies SessionWorkInput[];
    const work = await loadSessionWork(ctx.db, inputs);
    return {
      enabled,
      generated_at: snapshot.generated_at,
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
      const query = z.object({
        after: z.coerce.number().int().min(0).optional(),
        session_id: z.string().uuid().optional(),
      }).parse(req.query ?? {});
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
      const disconnected = new AbortController();
      let closed = false;
      reply.raw.once('close', () => {
        closed = true;
        disconnected.abort();
      });
      reply.raw.flushHeaders();
      let lastHeartbeat = Date.now();
      while (!closed && !reply.raw.destroyed) {
        try {
          // A stream can outlive logout, revocation or a role change. Resolve
          // afresh without extending the session's lifetime on every SSE tick.
          const admin = await auth.resolveSession(req.cookies?.[ctx.env.ADMIN_SESSION_COOKIE]);
          if (!admin) throw new UnauthorizedError('Admin session required', 'admin_required');
          req.admin = admin;
          await app.assertCapability(req, 'agent_portal.reveal_transcript');
          if (!(await portal.isEnabled())) {
            throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
          }
          const page = await portal.listEventsAfter(cursor, 250, query.session_id);
          if (closed) break;
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
            if (!reply.raw.write(`: heartbeat ${Date.now()}\n\nevent: heartbeat\ndata: ${JSON.stringify({ server_time: new Date().toISOString() })}\n\n`)) closed = true;
            lastHeartbeat = Date.now();
          }
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'stream_error';
          reply.raw.write(`event: unavailable\ndata: ${JSON.stringify({ code })}\n\n`);
          break;
        }
        if (!closed) await delay(1000, undefined, { signal: disconnected.signal }).catch(() => {});
      }
      reply.raw.end();
    },
  );

  app.get('/admin/agent-sessions/:id/events', { preHandler: app.requireAdmin }, async (req) => {
    const query = z
      .object({
        after: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(EVENT_PAGE_MAX).optional(),
        tail: z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1').optional(),
      })
      .parse(req.query ?? {});
    return await portal.listEvents(
      stringParam(req.params, 'id'),
      query.after ?? 0,
      query.limit ?? 250,
      query.tail ?? false,
    );
  });

  // The cooperative writes. All three insert into `agent_messages`, which is
  // what 0027 made reachable from a console session; before it they existed
  // only at /go and only for a magic-link user. The service still owns every
  // rule they obey -- relay readiness, live session, idempotency, delivery-time
  // revocation -- so these routes stay a thin, audited shell over it.
  app.post('/admin/agent-sessions/:id/messages', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = messageSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    reply.code(202);
    return await portal.enqueueMessage(adminActor(req), {
      sessionId: stringParam(req.params, 'id'),
      clientMessageId: parsed.data.client_message_id,
      content: parsed.data.content,
    });
  });

  app.post(
    '/admin/agent-sessions/:id/prompts/:promptId/answer',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = answerSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw badRequest(parsed.error.issues[0]);
      reply.code(202);
      return await portal.answerPrompt(adminActor(req), {
        sessionId: stringParam(req.params, 'id'),
        promptId: stringParam(req.params, 'promptId'),
        clientMessageId: parsed.data.client_message_id,
        answer: parsed.data.answer,
        version: parsed.data.version,
      });
    },
  );

  // Cooperative close: queued for the agent to pick up and honour. Distinct
  // from force below, which is what an operator reaches for once the agent can
  // no longer pick anything up.
  app.post('/admin/agent-sessions/:id/close', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = forceSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    reply.code(202);
    return await portal.requestClose(adminActor(req), {
      sessionId: stringParam(req.params, 'id'),
      clientMessageId: parsed.data.client_message_id,
      note: parsed.data.note,
    });
  });

  app.post('/admin/agent-sessions/:id/close/force', { preHandler: app.requireAdmin }, async (req) => {
    const parsed = forceSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0]);
    const sessionId = stringParam(req.params, 'id');
    const result = await portal.forceClose(
      adminActor(req),
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
