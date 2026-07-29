import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ApiError, ForbiddenError, ServiceUnavailableError, ValidationError } from '../../http/errors.js';
import { ok } from '../../http/reply.js';
import { createAgentPortalService } from '../../services/agent-portal.js';

export async function registerAgentPortalPublicRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const identityFor = async (req: FastifyRequest) =>
    await portal.authenticateBrowser(req.cookies[ctx.env.AGENT_PORTAL_COOKIE]);

  app.get('/go/api/state', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    return ok({ enabled: await portal.isEnabled() });
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
    return ok({ user: (await identityFor(req)).user });
  });

  app.get('/go/api/agents', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    await identityFor(req);
    return ok({ agents: await portal.listAgents() });
  });

  app.get('/go/api/agents/:id/events', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    await identityFor(req);
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
    const identity = await identityFor(req);
    const body = z
      .object({ client_message_id: z.string(), content: z.string() })
      .parse(req.body ?? {});
    reply.code(202);
    return ok(
      await portal.enqueueMessage(identity, {
        sessionId: stringParam(req.params, 'id'),
        clientMessageId: body.client_message_id,
        content: body.content,
      }),
    );
  });

  app.post('/go/api/agents/:id/prompts/:promptId/answer', async (req, reply) => {
    assertPortalOrigin(req, ctx, true);
    portalHeaders(reply);
    const identity = await identityFor(req);
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
      await portal.answerPrompt(identity, {
        sessionId: stringParam(params, 'id'),
        promptId: stringParam(params, 'promptId'),
        clientMessageId: body.client_message_id,
        answer: body.answer,
        version: body.version,
      }),
    );
  });

  app.get('/go/api/events', async (req, reply) => {
    assertPortalOrigin(req, ctx, false);
    portalHeaders(reply);
    const browserToken = req.cookies[ctx.env.AGENT_PORTAL_COOKIE];
    await portal.authenticateBrowser(browserToken);
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
        const page = await portal.listEventsAfterAuthenticated(browserToken, cursor, 250);
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
  app.get('/go/', sendShell);
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
