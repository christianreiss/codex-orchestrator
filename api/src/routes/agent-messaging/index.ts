import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ForbiddenError, UnauthorizedError, ValidationError } from '../../http/errors.js';
import { clientGone } from '../../http/long-poll.js';
import { ROLE_ADMIN, ROLE_OWNER } from '../../services/admin-auth.js';
import { createAdminEventsService } from '../../services/admin-events.js';
import {
  createAgentMessagingService,
  type AgentMessagingOutcome,
} from '../../services/agent-messaging.js';
import { createHostAuthService } from '../../services/host-auth.js';
import { createInsecureWindowService } from '../../services/insecure-window.js';
import { parseEngine } from '../../util/engine.js';
import { adminSpaHtmlPreHandler } from '../admin/pages/static.js';
import type { RouteContext } from '../index.js';

const BRIDGE_TOKEN_HEADER = 'x-agent-bridge-token';
const RELAY_TOKEN_HEADER = 'x-agent-relay-token';
const JSON_OBJECT_SCHEMA = z.object({}).catchall(z.unknown());

export const requireAgentMessagingMutationRole = async (req: FastifyRequest): Promise<void> => {
  if (!req.admin) throw new UnauthorizedError('Admin session required', 'admin_required');
  const role = req.admin.user.accessLevel;
  if (role !== ROLE_OWNER && role !== ROLE_ADMIN) {
    throw new ForbiddenError('Insufficient access level', 'admin_role_required');
  }
};

export async function registerAgentMessagingRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const messaging = createAgentMessagingService(ctx.db, ctx.env, ctx.keyring);
  const events = createAdminEventsService(ctx.db);
  const adminSpa = adminSpaHtmlPreHandler(ctx);
  const actor = (req: FastifyRequest): number | null => req.admin?.user.id ?? null;

  // Admin state and operations. Content is never returned by a listing; reveal
  // is an explicit role-gated POST and records an audit row without broadcast.
  app.get('/admin/agent-messaging/state', { preHandler: app.requireAdmin }, async () =>
    await messaging.state(),
  );
  app.post(
    '/admin/agent-messaging/state',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req) => {
      const body = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
      const result = await messaging.setEnabled(body.enabled);
      await events.record(
        {
          type: 'agent_messaging.state.changed',
          payload: { ...result, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  app.get('/admin/agent-messaging', { preHandler: [adminSpa, app.requireAdmin] }, async () =>
    await messaging.listAdminAddresses(),
  );
  app.get('/admin/agent-messaging/addresses', { preHandler: app.requireAdmin }, async () =>
    await messaging.listAdminAddresses(),
  );
  app.patch(
    '/admin/agent-messaging/addresses/:id',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req) => {
      const id = stringParam(req.params, 'id');
      const body = z.object({ alias: z.string().nullable().optional() }).strict().parse(req.body ?? {});
      const result = await messaging.setAddressAlias(id, body.alias ?? null);
      await events.record(
        {
          type: 'agent_messaging.address.changed',
          payload: { address_id: id, alias: body.alias ?? null, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  app.post(
    '/admin/agent-messaging/addresses/:id/enabled',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req) => {
      const id = stringParam(req.params, 'id');
      const body = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
      const result = await messaging.setAddressEnabled(id, body.enabled);
      await events.record(
        {
          type: 'agent_messaging.address.changed',
          payload: { address_id: id, enabled: body.enabled, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  app.get('/admin/agent-messaging/conversations', { preHandler: app.requireAdmin }, async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    return await messaging.listAdminConversations({
      status: optionalString(query.status),
      limit: optionalPositiveInt(query.limit),
    });
  });
  app.post(
    '/admin/agent-messaging/conversations/:id/cancel',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req) => {
      const id = stringParam(req.params, 'id');
      const body = z.object({ reason: z.string().nullable().optional() }).strict().parse(req.body ?? {});
      const result = await messaging.adminCancelConversation(id, body.reason);
      await events.record(
        {
          type: 'agent_messaging.conversation.changed',
          payload: { conversation_id: id, status: 'canceled', admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  app.get('/admin/agent-messaging/messages', { preHandler: app.requireAdmin }, async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    return await messaging.listAdminMessages({
      conversationId: optionalString(query.conversation_id),
      status: optionalString(query.status),
      limit: optionalPositiveInt(query.limit),
    });
  });
  app.post(
    '/admin/agent-messaging/messages/:id/reveal',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req, reply) => {
      const id = stringParam(req.params, 'id');
      const result = await messaging.revealMessage(id);
      await events.record(
        {
          type: 'agent_messaging.message.revealed',
          payload: { message_id: id, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      reply.header('cache-control', 'no-store');
      reply.header('pragma', 'no-cache');
      return result;
    },
  );
  app.post(
    '/admin/agent-messaging/messages/:id/redrive',
    { preHandler: [app.requireAdmin, requireAgentMessagingMutationRole] },
    async (req) => {
      const id = stringParam(req.params, 'id');
      const result = await messaging.redriveMessage(id);
      await events.record(
        {
          type: 'agent_messaging.message.changed',
          payload: { redrive_of_message_id: id, admin_user_id: actor(req) },
        },
        { broadcast: false },
      );
      return result;
    },
  );
  // There is no per-host switch. The fleet switch above is the only switch;
  // an insecure host is bounded by its allowed window, which is managed on
  // Host Detail like every other insecure-window decision.

  // Session-bound model/adapter API. All routes require the short-lived bridge
  // capability inherited through the private cxx Unix broker.
  app.post('/host/agent-sessions/:id/agent-messaging/list', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({ engine: z.enum(['codex', 'claude']).optional(), host_id: z.number().int().positive().optional(), include_offline: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.listAddresses(id, token, {
      engine: body.engine ? parseEngine(body.engine) : undefined,
      hostId: body.host_id,
      includeOffline: body.include_offline,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/send', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        to: z.string(),
        content: z.string(),
        client_message_id: z.string().uuid(),
        conversation_id: z.string().uuid().nullable().optional(),
        ttl_seconds: z.number().int().nullable().optional(),
        kind: z.enum(['message', 'request']).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.sendMessage(id, token, {
      to: body.to,
      content: body.content,
      clientMessageId: body.client_message_id,
      conversationId: body.conversation_id,
      ttlSeconds: body.ttl_seconds,
      kind: body.kind,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/reply', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({ message_id: z.string().uuid(), content: z.string(), client_message_id: z.string().uuid(), ttl_seconds: z.number().int().nullable().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.replyMessage(id, token, body.message_id, {
      content: body.content,
      clientMessageId: body.client_message_id,
      ttlSeconds: body.ttl_seconds,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/wait', async (req, reply) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ conversation_id: z.string().uuid(), after: z.number().int().nonnegative().optional(), seconds: z.number().int().min(0).max(25).optional() }).strict().parse(req.body ?? {});
    const deadline = Date.now() + (body.seconds ?? 20) * 1000;
    while (true) {
      const result = await messaging.waitForMessages(id, token, body.conversation_id, body.after ?? 0);
      if ((result.messages as unknown[]).length > 0 || Date.now() >= deadline || clientGone(reply)) return result;
      await delay(400);
    }
  });
  app.post('/host/agent-sessions/:id/agent-messaging/message', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ message_id: z.string().uuid() }).strict().parse(req.body ?? {});
    return await messaging.getMessage(id, token, body.message_id);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/cancel', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ conversation_id: z.string().uuid(), reason: z.string().nullable().optional() }).strict().parse(req.body ?? {});
    return await messaging.cancelConversation(id, token, body.conversation_id, body.reason);
  });
  // The ring. Read-only and, unlike `deliveries/claim`, usable before the
  // session has ever bound receive-capable -- that is the state it exists to
  // rescue. It takes no body: a mailbox is not a query.
  app.post('/host/agent-sessions/:id/agent-messaging/mailbox', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    z.object({}).strict().parse(req.body ?? {});
    return await messaging.peekMailbox(id, token);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/call/open', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({ ttl_seconds: z.number().int().min(60).max(3600).nullable().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.openCall(id, token, { ttlSeconds: body.ttl_seconds });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/call/join', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        // A string, never a number: `0042` must keep its leading zeros.
        pin: z.string().regex(/^[0-9]{4}$/),
        content: z.string(),
        client_message_id: z.string().uuid(),
        ttl_seconds: z.number().int().nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.joinCall(id, token, {
      pin: body.pin,
      content: body.content,
      clientMessageId: body.client_message_id,
      ttlSeconds: body.ttl_seconds,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/open', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        topic: z.string().nullable().optional(),
        purpose: z.string().nullable().optional(),
        ttl_seconds: z.number().int().min(300).max(21600).nullable().optional(),
        max_members: z.number().int().min(2).max(8).nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.openConference(id, token, {
      topic: body.topic,
      purpose: body.purpose,
      ttlSeconds: body.ttl_seconds,
      maxMembers: body.max_members,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/invite', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        conference_id: z.string().uuid(),
        to: z.array(z.string()).min(1).max(8),
        note: z.string().nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.inviteToConference(id, token, {
      conferenceId: body.conference_id,
      to: body.to,
      note: body.note,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/join', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        // A string, never a number: `0042` must keep its leading zeros.
        pin: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
        conference_id: z.string().uuid().nullable().optional(),
        purpose: z.string().nullable().optional(),
        content: z.string().nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.joinConference(id, token, {
      pin: body.pin,
      conferenceId: body.conference_id,
      purpose: body.purpose,
      content: body.content,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/roster', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ conference_id: z.string().uuid() }).strict().parse(req.body ?? {});
    return await messaging.conferenceRoster(id, token, body.conference_id);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/say', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({ conference_id: z.string().uuid(), content: z.string(), to: z.string().nullable().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.conferenceSay(id, token, {
      conferenceId: body.conference_id,
      content: body.content,
      to: body.to,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/dispatch', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        conference_id: z.string().uuid(),
        to: z.string(),
        task: z.string(),
        eta_seconds: z.number().int().min(0).max(14400).nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.conferenceDispatch(id, token, {
      conferenceId: body.conference_id,
      to: body.to,
      task: body.task,
      etaSeconds: body.eta_seconds,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/conf/adjourn', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({ conference_id: z.string().uuid(), reason: z.string().nullable().optional(), force: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.adjournConference(id, token, {
      conferenceId: body.conference_id,
      reason: body.reason,
      force: body.force,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/bind', async (req) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z
      .object({
        upstream_session_id: z.string().nullable().optional(),
        adapter_protocol: z.string().nullable().optional(),
        adapter_capabilities: JSON_OBJECT_SCHEMA.nullable().optional(),
        receive_capable: z.boolean(),
        binding_generation: z.number().int().nonnegative().nullable().optional(),
        continuity: z.enum(['native', 'reset']).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.heartbeatSession(id, token, {
      upstreamSessionId: body.upstream_session_id,
      adapterProtocol: body.adapter_protocol,
      adapterCapabilities: body.adapter_capabilities,
      receiveCapable: body.receive_capable,
      expectedBindingGeneration: body.binding_generation,
      continuity: body.continuity,
    });
  });
  app.post('/host/agent-sessions/:id/agent-messaging/deliveries/claim', async (req, reply) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ claim_id: z.string().uuid(), wait_seconds: z.number().int().min(0).max(25).optional() }).strict().parse(req.body ?? {});
    const deadline = Date.now() + (body.wait_seconds ?? 20) * 1000;
    while (true) {
      const delivery = await messaging.claimForSession(id, token, body.claim_id);
      if (delivery || Date.now() >= deadline || clientGone(reply)) return { delivery };
      await delay(400);
    }
  });
  app.post('/host/agent-sessions/:id/agent-messaging/deliveries/:messageId/renew', async (req) => {
    const id = stringParam(req.params, 'id');
    const messageId = stringParam(req.params, 'messageId');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = z.object({ claim_id: z.string().uuid() }).strict().parse(req.body ?? {});
    return await messaging.renewSessionDelivery(id, token, messageId, body.claim_id);
  });
  app.post('/host/agent-sessions/:id/agent-messaging/deliveries/:messageId/ack', async (req) => {
    const id = stringParam(req.params, 'id');
    const messageId = stringParam(req.params, 'messageId');
    const token = requireToken(req, BRIDGE_TOKEN_HEADER, 'agent_bridge_token_required');
    const body = deliveryAckSchema.parse(req.body ?? {});
    return await messaging.acknowledgeSessionDelivery(id, token, messageId, ackInput(body));
  });

  // One outbound-only per-user relay. Registration uses host authentication;
  // every poll after it uses the generation-fenced short-lived relay token.
  const insecure = createInsecureWindowService({ db: ctx.db, env: ctx.env });
  const hostAuth = createHostAuthService({ db: ctx.db, env: ctx.env, insecure });
  app.post('/host/agent-relays/register', async (req) => {
    const host = await hostAuth.authenticate(req);
    const body = z
      .object({ username: z.string(), instance_id: z.string().uuid(), wrapper_version: z.string(), capabilities: JSON_OBJECT_SCHEMA.nullable().optional() })
      .strict()
      .parse(req.body ?? {});
    return await messaging.registerRelay(host, {
      username: body.username,
      instanceId: body.instance_id,
      wrapperVersion: body.wrapper_version,
      capabilities: body.capabilities,
    });
  });
  app.post('/host/agent-relays/:id/heartbeat', async (req) => {
    const id = stringParam(req.params, 'id');
    return await messaging.heartbeatRelay(id, requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required'));
  });
  app.post('/host/agent-relays/:id/stop', async (req) => {
    const id = stringParam(req.params, 'id');
    return await messaging.stopRelay(id, requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required'));
  });
  app.post('/host/agent-relays/:id/deliveries/claim', async (req, reply) => {
    const id = stringParam(req.params, 'id');
    const token = requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required');
    const body = z.object({ claim_id: z.string().uuid(), wait_seconds: z.number().int().min(0).max(25).optional() }).strict().parse(req.body ?? {});
    const deadline = Date.now() + (body.wait_seconds ?? 20) * 1000;
    while (true) {
      const delivery = await messaging.claimForRelay(id, token, body.claim_id);
      if (delivery || Date.now() >= deadline || clientGone(reply)) return { delivery };
      await delay(400);
    }
  });
  app.post('/host/agent-relays/:id/deliveries/:messageId/renew', async (req) => {
    const id = stringParam(req.params, 'id');
    const messageId = stringParam(req.params, 'messageId');
    const token = requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required');
    const body = z.object({ claim_id: z.string().uuid() }).strict().parse(req.body ?? {});
    return await messaging.renewRelayDelivery(id, token, messageId, body.claim_id);
  });
  app.post('/host/agent-relays/:id/deliveries/:messageId/reply', async (req) => {
    const id = stringParam(req.params, 'id');
    const messageId = stringParam(req.params, 'messageId');
    const token = requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required');
    const body = z
      .object({
        claim_id: z.string().uuid(),
        content: z.string(),
        client_message_id: z.string().uuid(),
        delivery_session_id: z.string().uuid().nullable().optional(),
        upstream_session_id: z.string().nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return await messaging.replyFromRelayDelivery(id, token, messageId, {
      claimId: body.claim_id,
      content: body.content,
      clientMessageId: body.client_message_id,
      deliverySessionId: body.delivery_session_id,
      upstreamSessionId: body.upstream_session_id,
    });
  });
  app.post('/host/agent-relays/:id/deliveries/:messageId/ack', async (req) => {
    const id = stringParam(req.params, 'id');
    const messageId = stringParam(req.params, 'messageId');
    const token = requireToken(req, RELAY_TOKEN_HEADER, 'agent_relay_token_required');
    const body = deliveryAckSchema.extend({ delivery_session_id: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
    return await messaging.acknowledgeRelayDelivery(id, token, messageId, {
      ...ackInput(body),
      deliverySessionId: body.delivery_session_id,
    });
  });
}

const deliveryAckSchema = z
  .object({
    claim_id: z.string().uuid(),
    outcome: z.enum(['accepted', 'completed', 'retry', 'dead', 'ambiguous']),
    upstream_session_id: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .strict();

function ackInput(body: z.infer<typeof deliveryAckSchema>): {
  claimId: string;
  outcome: AgentMessagingOutcome;
  upstreamSessionId?: string | null;
  errorCode?: string | null;
  error?: string | null;
} {
  return {
    claimId: body.claim_id,
    outcome: body.outcome,
    upstreamSessionId: body.upstream_session_id,
    errorCode: body.error_code,
    error: body.error,
  };
}

function requireToken(req: FastifyRequest, header: string, code: string): string {
  const raw = req.headers[header];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (typeof token !== 'string' || !token.trim()) throw new ForbiddenError('Scoped agent credential required', code);
  return token.trim();
}

function stringParam(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${key} is required`, { param: key });
  return value.trim();
}

function positiveId(params: unknown): number {
  const value = Number((params as Record<string, unknown> | null)?.id ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidationError('id must be a positive integer', { param: 'id' });
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidationError('limit must be a positive integer', { param: 'limit' });
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
