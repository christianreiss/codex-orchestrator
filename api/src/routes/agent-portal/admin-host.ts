import { and, eq, gt } from 'drizzle-orm';
import { agentSessions, providerAccountSessions } from '../../db/schema.js';
import { AgentCoordination } from '../../services/agent-coordination/index.js';
import { NativeStopService } from '../../services/native-stop.js';
import { activityInputSchema } from '../../services/agent-activity.js';
import { taskResultSchema } from '../../services/agent-messaging/task-execution.js';
import { workspaceInputSchema } from '../../services/agent-messaging/workspace.js';
import { RebootHandoffs } from '../../services/reboot-handoffs.js';
import { HostDaemonService } from '../../services/host-daemon/service.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from '../index.js';
import { ApiError, ForbiddenError, ValidationError } from '../../http/errors.js';
import { clientGone } from '../../http/long-poll.js';
import { ok } from '../../http/reply.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import {
  AGENT_BRIDGE_EVENT_TYPES,
  createAgentPortalService,
  type AgentEventInput,
} from '../../services/agent-portal.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { parseEngine } from '../../util/engine.js';
import { assertHostEngineEnabled } from '../../services/host-engine-policy.js';
import { readFleetEngineState } from '../../services/engine-switch.js';
import { createAgentMessagingService, messagingHostEligible } from '../../services/agent-messaging.js';
import { WATCHDOG_FAILURES } from '../../services/watchdog-lifecycle.js';

const BRIDGE_TOKEN_HEADER = 'x-agent-bridge-token';
const JSON_OBJECT_SCHEMA = z.object({}).catchall(z.unknown());

export async function registerAgentPortalAdminHostRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const portal = createAgentPortalService(ctx.db, ctx.env, ctx.keyring);
  const messaging = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const events = createAdminEventsService(ctx.db);

  app.get('/admin/agent-portal/state', { preHandler: app.requireAdmin }, async () =>
    ok(await portal.state()),
  );

  app.post('/admin/agent-portal/state', { preHandler: app.requireAdmin }, async (req) => {
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

  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
  const authenticateHost = async (req: FastifyRequest, purpose: string) => {
    const raw = await hostAuth.authenticate(req);
    return raw.secure === 1 ? raw : await insecure.enforce(raw, purpose, req.clientIp);
  };

  const reboot = new RebootHandoffs(ctx.db, ctx.keyring);
  const rebootHandler = (operation: 'ready' | 'observe' | 'disarm' | 'finish') => async (req: FastifyRequest) => {
      const host = await authenticateHost(req, 'reboot_handoff');
      const body = z.object({ request_id: z.string().uuid(), boot_id: z.string().uuid().optional(), failed: z.boolean().optional(), task_result: taskResultSchema.optional() }).strict().parse(req.body);
      if (operation === 'disarm') return reboot.disarm(host.id, body.request_id);
      if (operation === 'finish') return reboot.finish(host.id, body.request_id, body.failed ?? true, body.task_result);
      if (operation === 'observe') return reboot.observe(host.id, body.request_id);
      if (!body.boot_id) throw new ValidationError('boot_id required');
      const record = await reboot.ready(host.id, body.request_id, body.boot_id);
      assertHostEngineEnabled(host, parseEngine(record.engine), await readFleetEngineState(ctx.db));
      if (!(await messaging.isEnabled()) || !messagingHostEligible(host)) throw new ForbiddenError('Agent messaging is disabled');
      return record;
  };
  app.post('/host/reboot-handoffs/ready', rebootHandler('ready'));
  app.post('/host/reboot-handoffs/observe', rebootHandler('observe'));
  app.post('/host/reboot-handoffs/disarm', rebootHandler('disarm'));
  app.post('/host/reboot-handoffs/finish', rebootHandler('finish'));

  app.get('/host/agent-portal/state', async (req) => {
    const host = await authenticateHost(req, 'agent_portal_state');
    return { enabled: await portal.isEnabled(), host_id: host.id };
  });

  app.post('/host/agent-sessions', async (req) => {
    const host = await authenticateHost(req, 'agent_session_register');
    const body = z
      .object({
        reboot_request_id: z.string().uuid().optional(),
        reboot_boot_id: z.string().uuid().optional(),
        engine: z.string(),
        username: z.string(),
        cwd: z.string(),
        workspace: workspaceInputSchema.optional(),
        upstream_session_id: z.string().nullable().optional(),
        provider_session_id: z.string().max(64).optional(),
        invocation_kind: z.enum(['interactive', 'execute', 'peer_delivery']),
        resumed: z.boolean().optional(),
        session_id: z.string().uuid().optional(),
        bridge_token: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
        delivery_message_id: z.string().uuid().optional(),
        delivery_claim_id: z.string().uuid().optional(),
        daemon_operation_id: z.string().uuid().optional(),
        daemon_claim_id: z.string().uuid().optional(),
        agent_address: z.string().nullable().optional(),
        binding_generation: z.number().int().nonnegative().nullable().optional(),
        continuity: z.enum(['native', 'reset']).optional(),
        adapter_protocol: z.string().nullable().optional(),
        adapter_capabilities: JSON_OBJECT_SCHEMA.nullable().optional(),
      })
      .parse(req.body ?? {});
    const engine = parseEngine(body.engine);
    assertHostEngineEnabled(host, engine, await readFleetEngineState(ctx.db));
    const [providerLease] = body.provider_session_id ? await ctx.db.select().from(providerAccountSessions).where(and(
      eq(providerAccountSessions.id, body.provider_session_id), eq(providerAccountSessions.hostId, host.id),
      eq(providerAccountSessions.engine, engine), gt(providerAccountSessions.expiresAt, new Date().toISOString()),
    )) : [];
    if (body.provider_session_id && !providerLease) throw new ForbiddenError('Provider account lease is unavailable');
    const sessionId = body.session_id ?? randomUUID();
    const bridgeToken = body.bridge_token ?? randomBytes(32).toString('base64url');
    const [portalEnabled, messagingEnabled] = await Promise.all([
      portal.isEnabled(),
      messaging.isEnabled(),
    ]);
    let portalResult: Awaited<ReturnType<typeof portal.registerAgent>> = { enabled: false };
    let messagingResult: Record<string, unknown> = { enabled: false };
    if (messagingEnabled && messagingHostEligible(host)) {
      messagingResult = await messaging.registerSession(host, {
        rebootRequestId: body.reboot_request_id,
        rebootBootId: body.reboot_boot_id,
        engine,
        username: body.username,
        cwd: body.cwd,
        workspace: body.workspace,
        upstreamSessionId: body.upstream_session_id,
        invocationKind: body.invocation_kind,
        resumed: body.resumed,
        sessionId,
        bridgeToken,
        deliveryMessageId: body.delivery_message_id,
        deliveryClaimId: body.delivery_claim_id,
        requestedAddress: body.agent_address,
        expectedBindingGeneration: body.binding_generation,
        continuity: body.continuity,
        adapterProtocol: body.adapter_protocol,
        adapterCapabilities: body.adapter_capabilities,
      });
    }
    const remoteAddress = messagingResult.address as { id?: string } | undefined;
    const daemonPeer = body.invocation_kind === 'peer_delivery' && remoteAddress?.id
      ? await new HostDaemonService(ctx).bindPeer(host.id, sessionId, remoteAddress.id) : false;
    if (portalEnabled && (body.invocation_kind !== 'peer_delivery' || body.daemon_operation_id || daemonPeer)) {
      portalResult = await portal.registerAgent(host, {
        engine,
        username: body.username,
        cwd: body.cwd,
        workspace: body.workspace,
        upstreamSessionId: body.upstream_session_id,
        invocationKind: body.invocation_kind,
        resumed: body.resumed,
        sessionId,
        bridgeToken,
      });
    }
    // bindPeer runs before registration to decide Portal eligibility. Link the
    // newly registered Portal row as well, before the child can publish a reply.
    if (daemonPeer && remoteAddress?.id && portalResult.enabled) {
      await new HostDaemonService(ctx).bindPeer(host.id, sessionId, remoteAddress.id);
    }
    if (body.daemon_operation_id && body.daemon_claim_id) {
      const address = messagingResult.address as { id?: string; address?: string } | undefined;
      const addressId = address?.id ?? address?.address?.replace(/^agent:/, '');
      if (!addressId) throw new ForbiddenError('Messaging identity required for daemon session');
      await new HostDaemonService(ctx).bind(host.id, body.daemon_operation_id, body.daemon_claim_id, sessionId, addressId);
    }
    const enabled = portalResult.enabled || messagingResult.enabled === true;
    if (!enabled) {
      return {
        enabled: false,
        capabilities: { portal: false, agent_messaging: false },
      };
    }
    if (providerLease) {
      // Serialize registration retries before attaching the immutable account binding.
      await ctx.db.transaction(async tx => {
        const [registered] = await tx.select().from(agentSessions).where(and(
          eq(agentSessions.id, sessionId), eq(agentSessions.hostId, host.id), eq(agentSessions.engine, engine),
        )).for('update');
        if (!registered || (registered.providerAccountId && registered.providerAccountId !== providerLease.accountId))
          throw new ForbiddenError('Provider account binding changed');
        await tx.update(agentSessions).set({ providerAccountId: providerLease.accountId }).where(eq(agentSessions.id, sessionId));
      });
    }
    const coordination = new AgentCoordination(ctx.db, ctx.env, ctx.keyring, messaging);
    let scopeContext: Record<string, unknown> | null = null;
    if (messagingResult.enabled === true) {
      let coordinationEnabled: boolean | undefined;
      try {
        coordinationEnabled = await coordination.enabled();
        if (coordinationEnabled) scopeContext = await coordination.context(sessionId, bridgeToken);
      } catch (error) {
        // Naming and the authenticated binding have already committed. Optional
        // room enrichment must not strand that launch on a database/read error.
        // Domain failures still fence revoked credentials and stale bindings.
        if (error instanceof ApiError) throw error;
        const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code
          ?? (error as { code?: unknown } | null)?.code;
        req.log.warn({ session_id: sessionId, code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unknown' },
          'Optional scope snapshot unavailable after session registration');
        scopeContext = { ...(coordinationEnabled === undefined ? {} : { enabled: coordinationEnabled }),
          protocol: 1, available: false, reason: 'snapshot_unavailable' };
      }
    }
    return {
      ...(scopeContext ? { scope_context: scopeContext } : {}),
      enabled: true,
      session_id: sessionId,
      bridge_token: bridgeToken,
      expires_at:
        (messagingResult.expires_at as string | undefined) ??
        (portalResult.enabled ? portalResult.expires_at : undefined),
      capabilities: {
        portal: portalResult.enabled,
        agent_messaging: messagingResult.enabled === true,
      },
      ...(messagingResult.address ? { agent_address: messagingResult.address, name_status: messagingResult.name_status } : {}),
    };
  });

  app.post('/host/agent-sessions/:id/native-control', async req => {
    const id = stringParam(req.params, 'id');
    const body = z.object({ protocol: z.literal(1), instance_id: z.string().uuid(), report: z.object({ request_id: z.string().uuid(), status: z.enum(['accepted', 'exited', 'refused']) }).strict().optional() }).strict().parse(req.body);
    await portal.authenticateBridge(id, requireBridgeToken(req), undefined, Boolean(body.report));
    return new NativeStopService(ctx.db).poll(id, body.instance_id, body.report);
  });

  app.post('/host/agent-sessions/:id/activity', async (req) =>
    portal.reportActivity(stringParam(req.params, 'id'), requireBridgeToken(req), activityInputSchema.parse(req.body)),
  );

  app.post('/host/agent-sessions/:id/heartbeat', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireBridgeToken(req);
    const body = z
      .object({
        status: z.enum(['starting', 'active', 'waiting', 'offline']).optional(),
        active_turn_id: z.string().nullable().optional(),
        relay_action: z.enum(['poll', 'close']).optional(),
        upstream_session_id: z.string().nullable().optional(),
        adapter_protocol: z.string().nullable().optional(),
        adapter_capabilities: JSON_OBJECT_SCHEMA.nullable().optional(),
        receive_capable: z.boolean().optional(),
        binding_generation: z.number().int().nonnegative().nullable().optional(),
        continuity: z.enum(['native', 'reset']).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const [portalEnabled, messagingEnabled] = await Promise.all([portal.isEnabled(), messaging.isEnabled()]);
    const portalResult = portalEnabled
      ? await portal.heartbeatAgent(id, token, {
          status: body.status,
          activeTurnId: body.active_turn_id,
          relayAction: body.relay_action,
        })
      : null;
    const messagingResult = messagingEnabled
      ? await messaging.heartbeatSession(id, token, {
          status: body.status,
          upstreamSessionId: body.upstream_session_id,
          adapterProtocol: body.adapter_protocol,
          adapterCapabilities: body.adapter_capabilities,
          receiveCapable: body.receive_capable,
          expectedBindingGeneration: body.binding_generation,
          continuity: body.continuity,
          // Liveness only. A session with no address is not a conflict here,
          // and must not take the portal half of this heartbeat down with it.
          skipIfUnbound: true,
        })
      : null;
    return {
      enabled: Boolean(portalResult || messagingResult),
      capabilities: { portal: Boolean(portalResult), agent_messaging: Boolean(messagingResult) },
      portal: portalResult,
      agent_messaging: messagingResult,
    };
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
    if (!(await portal.isEnabled())) return { enabled: false };
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
      .object({ status: z.enum(['completed', 'failed']), summary: z.string().optional(), watchdog_failure: z.enum(WATCHDOG_FAILURES).optional() })
      .parse(req.body ?? {});
    const [portalEnabled, messagingEnabled] = await Promise.all([portal.isEnabled(), messaging.isEnabled()]);
    const portalResult = portalEnabled ? await portal.finishAgent(id, token, body) : null;
    const messagingResult = messagingEnabled ? await messaging.finishSession(id, token, body.status, body.watchdog_failure) : null;
    if (messagingEnabled) {
      const coordination = new AgentCoordination(ctx.db, ctx.env, ctx.keyring, messaging);
      if (await coordination.enabled()) await coordination.tick();
    }
    return {
      enabled: Boolean(portalResult || messagingResult),
      capabilities: { portal: Boolean(portalResult), agent_messaging: Boolean(messagingResult) },
      portal: portalResult,
      agent_messaging: messagingResult,
    };
  });

  app.post('/host/agent-sessions/:id/commands/claim', async (req, reply) => {
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
      waiting = Date.now() < deadline && !clientGone(reply);
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
