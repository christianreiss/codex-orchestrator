import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ApiError, ForbiddenError, ServiceUnavailableError, UnauthorizedError, ValidationError } from '../../http/errors.js';
import { ok } from '../../http/reply.js';
import { createAgentPortalService, type PortalActor } from '../../services/agent-portal.js';
import type { Capability } from '../../security/capabilities.js';

export async function registerAgentPortalPublicRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  /**
   * Either identity may drive the portal.
   *
   * The magic link is no longer the only way in: an operator already signed in
   * to the console is already authenticated to this origin -- /go and /admin are
   * one Fastify process behind one `PUBLIC_BASE_URL` -- and making them exchange
   * a second credential for the same fleet was the friction this removes. The
   * link stays for anyone who has no console account.
   *
   * A portal cookie wins when it is valid, because it is the explicit choice.
   * When it is present but stale the original error is preserved unless an admin
   * session can take over, so the portal app keeps seeing its own
   * `agent_portal_session_expired` and its own re-login path.
   *
   * `capability` is what keeps this from being a hole. The /go routes carry no
   * inventory entry, so an admin arriving here would otherwise bypass the gates
   * the console enforces -- a `viewer` could message agents through the portal
   * having been refused at /admin. Both capabilities named by callers below are
   * always-enforced, which is precisely what makes them checkable off a route
   * key; `agent_portal.read` needs no check because every authenticated role
   * holds it.
   */
  const actorFor = async (req: FastifyRequest, capability?: Capability): Promise<PortalActor> => {
    const adminActor = async (): Promise<PortalActor | null> => {
      const admin = await app.resolveAdmin(req);
      if (!admin) return null;
      if (capability) await app.assertCapability(req, capability);
      return {
        kind: 'admin',
        user: {
          id: admin.user.id,
          displayName: admin.user.name?.trim() || admin.user.username?.trim() || 'Console operator',
        },
      };
    };
    const raw = req.cookies[ctx.env.AGENT_PORTAL_COOKIE];
    if (raw) {
      try {
        return { kind: 'portal', identity: await portal.authenticateBrowser(raw) };
      } catch (error) {
        const fallback = await adminActor();
        if (!fallback) throw error;
        return fallback;
      }
    }
    const admin = await adminActor();
    if (!admin) throw new UnauthorizedError('Portal login required', 'agent_portal_login_required');
    return admin;
  };

  /** The signed-in viewer, whichever identity table they came from. */
  const viewerFor = async (req: FastifyRequest): Promise<{ id: number; display_name: string; kind: string }> => {
    const actor = await actorFor(req);
    return actor.kind === 'portal'
      ? { id: actor.identity.user.id, display_name: actor.identity.user.display_name, kind: 'portal' }
      : { id: actor.user.id, display_name: actor.user.displayName, kind: 'admin' };
  };

  app.get('/go/api/state', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    return ok({ enabled: await portal.isEnabled(), timings: portal.timings() });
  });

  app.post('/go/api/auth/exchange', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const body = z.object({ public_id: z.string(), token: z.string() }).parse(req.body ?? {});
    const result = await portal.exchangeMagicLink({
      publicId: body.public_id,
      token: body.token,
      ip: requestIp(req),
      userAgent: req.headers['user-agent'],
    });
    reply.setCookie(ctx.env.AGENT_PORTAL_COOKIE, result.sessionToken, {
      path: '/go',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: ctx.env.AGENT_PORTAL_SESSION_TTL_HOURS * 3600,
    });
    return ok({ user: result.identity.user, expires_at: result.expiresAt });
  });

  app.post('/go/api/logout', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    await portal.logoutBrowser(req.cookies[ctx.env.AGENT_PORTAL_COOKIE]);
    reply.clearCookie(ctx.env.AGENT_PORTAL_COOKIE, {
      path: '/go',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    });
    return ok({});
  });

  app.get('/go/api/me', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    return ok({ user: await viewerFor(req) });
  });

  app.get('/go/api/agents', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    await actorFor(req);
    return ok({ agents: await portal.listAgents() });
  });

  app.get('/go/api/agents/:id/events', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    await actorFor(req, 'agent_portal.reveal_transcript');
    const query = z
      .object({
        after: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        tail: z.enum(['0', '1']).optional(),
      })
      .parse(req.query ?? {});
    return ok(await portal.listEvents(stringParam(req.params, 'id'), query.after, query.limit, query.tail === '1'));
  });

  app.post('/go/api/agents/:id/messages', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const actor = await actorFor(req, 'agent_portal.manage');
    const body = z
      .object({ client_message_id: z.string(), content: z.string() })
      .parse(req.body ?? {});
    reply.code(202);
    return ok(
      await portal.enqueueMessage(actor, {
        sessionId: stringParam(req.params, 'id'),
        clientMessageId: body.client_message_id,
        content: body.content,
      }),
    );
  });

  app.post('/go/api/agents/:id/prompts/:promptId/answer', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const actor = await actorFor(req, 'agent_portal.manage');
    const params = req.params as Record<string, unknown>;
    const body = z
      .object({
        client_message_id: z.string(),
        answer: z.string(),
        version: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});
    reply.code(202);
    return ok(
      await portal.answerPrompt(actor, {
        sessionId: stringParam(params, 'id'),
        promptId: stringParam(params, 'promptId'),
        clientMessageId: body.client_message_id,
        answer: body.answer,
        version: body.version,
      }),
    );
  });

  app.post('/go/api/agents/:id/close', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const actor = await actorFor(req, 'agent_portal.manage');
    const body = z
      .object({ client_message_id: z.string(), note: z.string().optional() })
      .parse(req.body ?? {});
    reply.code(202);
    return ok(
      await portal.requestClose(actor, {
        sessionId: stringParam(req.params, 'id'),
        clientMessageId: body.client_message_id,
        note: body.note,
      }),
    );
  });

  app.post('/go/api/agents/:id/close/force', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const actor = await actorFor(req, 'agent_portal.manage');
    const body = z
      .object({ client_message_id: z.string(), note: z.string().optional() })
      .parse(req.body ?? {});
    return ok(
      await portal.forceClose(actor, {
        sessionId: stringParam(req.params, 'id'),
        clientMessageId: body.client_message_id,
        note: body.note,
      }),
    );
  });

  app.get('/go/api/events', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    const browserToken = req.cookies[ctx.env.AGENT_PORTAL_COOKIE];
    const streamActor = await actorFor(req, 'agent_portal.reveal_transcript');
    /**
     * One page of events, re-authorizing first.
     *
     * The portal branch is unchanged: `listEventsAfterAuthenticated` re-reads
     * the browser session inside its own transaction on every tick, so revoking
     * a portal user stops their stream mid-flight rather than at the next
     * reconnect. The admin branch has to reproduce that rather than trusting the
     * check made when the connection opened -- a stream is long-lived and an
     * account can be disabled or demoted while it is open.
     */
    const nextPage = async (from: number) => {
      if (streamActor.kind === 'portal') {
        return await portal.listEventsAfterAuthenticated(browserToken, from, 250);
      }
      await actorFor(req, 'agent_portal.reveal_transcript');
      if (!(await portal.isEnabled())) {
        throw new ServiceUnavailableError('Agent portal is disabled', 'agent_portal_disabled');
      }
      return await portal.listEventsAfter(from, 250);
    };
    const query = z
      .object({ after: z.coerce.number().int().min(0).optional() })
      .parse(req.query ?? {});
    const rawHeaderCursor = req.headers['last-event-id'];
    const headerCursor = Number(Array.isArray(rawHeaderCursor) ? rawHeaderCursor[0] : rawHeaderCursor);
    let cursor = query.after ?? (
      rawHeaderCursor !== undefined && Number.isFinite(headerCursor)
        ? Math.max(0, Math.trunc(headerCursor))
        : await portal.latestEventCursor()
    );
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
        const page = await nextPage(cursor);
        for (const event of page.events) {
          cursor = Number(event.cursor ?? cursor);
          if (!reply.raw.write(`id: ${cursor}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`)) {
            // A stalled mobile client must reconnect with Last-Event-ID rather
            // than accumulating an unbounded server-side response buffer.
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
  });

  const portalRoot = resolve(
    ctx.env.STATIC_ROOT || resolve(import.meta.dirname, '../../../../public/admin'),
    '..',
    'go',
  );
  const assetsRoot = resolve(portalRoot, 'assets');
  if (existsSync(assetsRoot)) {
    await app.register(fastifyStatic, {
      root: assetsRoot,
      prefix: '/go/assets/',
      decorateReply: false,
      wildcard: true,
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    });
  }
  const indexPath = resolve(portalRoot, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  const sendShell = async (_req: FastifyRequest, reply: FastifyReply) => {
    portalHeaders(reply);
    if (!indexHtml) {
      throw new ServiceUnavailableError(
        'Agent portal client is not installed',
        'agent_portal_client_missing',
      );
    }
    reply.envelopeRaw = true;
    reply.type('text/html; charset=utf-8');
    return reply.send(indexHtml);
  };
  app.get('/go', sendShell);
  app.get('/go/u/:publicId', sendShell);
}

function stringParam(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${key} is required`, { param: key });
  }
  return value.trim();
}

export function assertPortalOrigin(req: FastifyRequest, ctx: RouteContext, mutation: boolean): void {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
    throw new ForbiddenError('Cross-origin portal request rejected', 'agent_portal_csrf');
  }
  const origin = req.headers.origin;
  if (!ctx.env.PUBLIC_BASE_URL) {
    if (!mutation && origin === undefined) return;
    throw new ServiceUnavailableError('PUBLIC_BASE_URL is not configured', 'agent_portal_not_configured');
  }
  let expected: string;
  try {
    expected = new URL(ctx.env.PUBLIC_BASE_URL).origin;
  } catch {
    throw new ServiceUnavailableError('PUBLIC_BASE_URL is invalid', 'agent_portal_not_configured');
  }
  if ((mutation && !origin) || (origin !== undefined && origin !== expected)) {
    throw new ForbiddenError('Portal origin mismatch', 'agent_portal_csrf');
  }
}

function portalHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
}

function requestIp(req: FastifyRequest): string | null {
  const decorated = (req as FastifyRequest & { clientIp?: string }).clientIp;
  return decorated ?? req.ip ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
