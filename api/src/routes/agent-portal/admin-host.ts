import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../http/errors.js';
import { ok } from '../../http/reply.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import {
  AGENT_BRIDGE_EVENT_TYPES,
  createAgentPortalService,
  type AgentEventInput,
} from '../../services/agent-portal.js';
import { ROLE_ADMIN, ROLE_OWNER } from '../../services/admin-auth.js';
import { createAuthFailureTracker } from '../../services/auth-failure-tracker.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { parseEngine } from '../../util/engine.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';

const BRIDGE_TOKEN_HEADER = 'x-agent-bridge-token';

export async function registerAgentPortalAdminHostRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const events = createAdminEventsService(ctx.db);
  const requireAgentPortalMutationRole = async (req: FastifyRequest): Promise<void> => {
    if (!req.admin) throw new UnauthorizedError('Admin session required', 'admin_required');
    const role = req.admin.user.accessLevel;
    if (role !== ROLE_OWNER && role !== ROLE_ADMIN) {
      throw new ForbiddenError('Insufficient access level', 'admin_role_required');
    }
  };

  app.get('/admin/agent-portal/state', { preHandler: app.requireAdmin }, async () =>
    ok(await portal.state()),
  );

  app.post('/admin/agent-portal/state', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const result = await portal.setEnabled(body.enabled);
    await events.record({
      type: 'agent_portal.state',
      payload: {
        enabled: body.enabled,
        canceled: result.canceled,
        revoked_sessions: result.revoked_sessions,
        admin_user_id: req.admin?.user.id ?? null,
      },
    });
    return ok(result);
  });

  app.get('/admin/agent-portal/users', { preHandler: app.requireAdmin }, async () =>
    ok({ users: await portal.listUsers() }),
  );

  app.post('/admin/agent-portal/users', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const body = z
      .object({ display_name: z.string(), enabled: z.boolean().optional() })
      .parse(req.body ?? {});
    const result = await portal.createUser({
      displayName: body.display_name,
      enabled: body.enabled,
    });
    await events.record({
      type: 'agent_portal.user.created',
      payload: {
        portal_user_id: result.user.id,
        enabled: result.user.enabled,
        admin_user_id: req.admin?.user.id ?? null,
      },
    });
    return ok(result);
  });

  app.post('/admin/agent-portal/users/:id', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const id = parsePositiveId(req.params);
    const body = z
      .object({ display_name: z.string().optional() })
      .strict()
      .parse(req.body ?? {});
    const user = await portal.updateUser(id, { displayName: body.display_name });
    await events.record({
      type: 'agent_portal.user.updated',
      payload: { portal_user_id: id, admin_user_id: req.admin?.user.id ?? null },
    });
    return ok({ user });
  });

  app.post('/admin/agent-portal/users/:id/enabled', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const id = parsePositiveId(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const result = await portal.setUserEnabled(id, body.enabled);
    await events.record({
      type: 'agent_portal.user.enabled',
      payload: {
        portal_user_id: id,
        enabled: body.enabled,
        canceled: result.canceled,
        revoked_sessions: result.revoked_sessions,
        admin_user_id: req.admin?.user.id ?? null,
      },
    });
    return ok(result);
  });

  app.post('/admin/agent-portal/users/:id/rotate', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const id = parsePositiveId(req.params);
    const result = await portal.rotateUser(id);
    await events.record({
      type: 'agent_portal.user.rotated',
      payload: {
        portal_user_id: id,
        revoked_sessions: result.revoked_sessions,
        admin_user_id: req.admin?.user.id ?? null,
      },
    });
    return ok(result);
  });

  // The permanent link is what the operator bookmarks, so it has to be readable
  // after creation. Gated to owner/admin and audited: `GET /admin/agent-portal/
  // users` is open to every admin session, including `viewer`, and must never
  // carry bearer material.
  app.get('/admin/agent-portal/users/:id/link', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const id = parsePositiveId(req.params);
    const result = await portal.revealUserLink(id);
    await events.record({
      type: 'agent_portal.user.link_revealed',
      payload: { portal_user_id: id, admin_user_id: req.admin?.user.id ?? null },
    });
    return ok(result);
  });

  app.delete('/admin/agent-portal/users/:id', { preHandler: [app.requireAdmin, requireAgentPortalMutationRole] }, async (req) => {
    const id = parsePositiveId(req.params);
    const result = await portal.deleteUser(id);
    await events.record({
      type: 'agent_portal.user.deleted',
      payload: {
        portal_user_id: id,
        canceled: result.canceled,
        revoked_sessions: result.revoked_sessions,
        admin_user_id: req.admin?.user.id ?? null,
      },
    });
    return ok(result);
  });

  const failures = createAuthFailureTracker(app);
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, failures, env: ctx.env, insecure });
  const authenticateHost = async (req: FastifyRequest, purpose: string) => {
    const raw = await hostAuth.authenticate(req);
    return raw.secure === 1 ? raw : await insecure.enforce(raw, purpose);
  };

  app.get('/host/agent-portal/state', async (req) => {
    const host = await authenticateHost(req, 'agent_portal_state');
    return { enabled: await portal.isEnabled(), host_id: host.id };
  });

  app.post('/host/agent-sessions', async (req) => {
    const host = await authenticateHost(req, 'agent_session_register');
    const body = z
      .object({
        engine: z.string(),
        username: z.string(),
        cwd: z.string(),
        upstream_session_id: z.string().nullable().optional(),
        invocation_kind: z.enum(['interactive', 'execute']),
        resumed: z.boolean().optional(),
        session_id: z.string().uuid().optional(),
        bridge_token: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
      })
      .parse(req.body ?? {});
    const engine = parseEngine(body.engine);
    assertHostEngineEnabled(host, engine);
    return await portal.registerAgent(host, {
      engine,
      username: body.username,
      cwd: body.cwd,
      upstreamSessionId: body.upstream_session_id,
      invocationKind: body.invocation_kind,
      resumed: body.resumed,
      sessionId: body.session_id,
      bridgeToken: body.bridge_token,
    });
  });

  app.post('/host/agent-sessions/:id/heartbeat', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireBridgeToken(req);
    const body = z
      .object({
        status: z.enum(['starting', 'active', 'waiting', 'offline']).optional(),
        active_turn_id: z.string().nullable().optional(),
        relay_action: z.enum(['poll', 'close']).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await portal.heartbeatAgent(id, token, {
      status: body.status,
      activeTurnId: body.active_turn_id,
      relayAction: body.relay_action,
    });
  });

  app.post('/host/agent-sessions/:id/events', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireBridgeToken(req);
    const body = z
      .object({
        client_event_id: z.string(),
        type: z.enum(AGENT_BRIDGE_EVENT_TYPES),
        payload: z.object({}).catchall(z.unknown()).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await portal.addAgentEvent(
      id,
      token,
      {
        clientEventId: body.client_event_id,
        type: body.type,
        source: 'engine',
        payload: body.payload,
      } satisfies AgentEventInput,
    );
  });

  app.post('/host/agent-sessions/:id/finish', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireBridgeToken(req);
    const body = z
      .object({ status: z.enum(['completed', 'failed']), summary: z.string().optional() })
      .parse(req.body ?? {});
    return await portal.finishAgent(id, token, body);
  });

  app.post('/host/agent-sessions/:id/commands/claim', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireBridgeToken(req);
    const body = z
      .object({
        wait_seconds: z.number().int().min(0).max(25).optional(),
        claim_id: z.string().uuid(),
      })
      .parse(req.body ?? {});
    const deadline = Date.now() + (body.wait_seconds ?? 20) * 1000;
    let waiting = true;
    while (waiting) {
      const message = await portal.claimMessage(id, token, body.claim_id);
      if (message) return { message };
      waiting = Date.now() < deadline && !req.raw.destroyed;
      if (!waiting) break;
      await delay(500);
    }
    return { message: null };
  });

  app.post('/host/agent-commands/:messageId/ack', async (req) => {
    const messageId = stringParam(req.params, 'messageId');
    const token = requireBridgeToken(req);
    const body = z
      .object({
        session_id: z.string(),
        lease_owner: z.string(),
        outcome: z.enum(['accepted', 'retry', 'failed']),
        upstream_id: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
      })
      .parse(req.body ?? {});
    return await portal.acknowledgeMessage(
      body.session_id,
      token,
      {
        messageId,
        leaseOwner: body.lease_owner,
        outcome: body.outcome,
        upstreamId: body.upstream_id,
        error: body.error,
      },
    );
  });
}

function parsePositiveId(params: unknown): number {
  const id = Number((params as Record<string, unknown> | null)?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ValidationError('id must be a positive integer', { param: 'id' });
  }
  return id;
}

function stringParam(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${key} is required`, { param: key });
  }
  return value.trim();
}

function requireBridgeToken(req: FastifyRequest): string {
  const raw = req.headers[BRIDGE_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== 'string' || !token) {
    throw new ForbiddenError('Agent bridge token required', 'agent_bridge_token_required');
  }
  return token;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
