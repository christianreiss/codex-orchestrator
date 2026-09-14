import { randomBytes, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
  logs,
  versions,
  type AgentBusAddress,
  type AgentBusConversation,
  type AgentBusMessage,
  type AgentBusRelay,
  type AgentSession,
  type Host,
} from '../db/schema.js';
import type { Env } from '../env.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, encrypt } from '../security/secret-box.js';
import { type Engine } from '../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import {
} from './agent-presence.js';
import { hostEnginesList } from './host-engine-policy.js';
import { isTruthyFlagValue, SettingsService } from './settings.js';

import {
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_ENABLED_KEY,
  AGENT_MESSAGING_LEASE_SECONDS,
  AGENT_MESSAGING_MAILBOX_PAGE_SIZE,
  AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS,
  AGENT_MESSAGING_MISSED_WINDOW_SECONDS,
  AGENT_MESSAGING_RECEIVE_FRESH_SECONDS,
  AGENT_MESSAGING_RELAY_TOKEN_SECONDS,
  AGENT_MESSAGING_WAIT_PAGE_SIZE,
  CANCELABLE_MESSAGE_STATUSES,
  TERMINAL_MESSAGE_STATUSES,
} from './agent-messaging/constants.js';
import {
  type AgentMessagingDb,
  type AgentMessagingOutcome,
  type MessageDelivery,
  type RegisterMessagingSessionInput,
} from './agent-messaging/types.js';
import {
  deliveryBackoffSeconds,
  normalizeErrorCode,
  normalizeMessageBody,
  normalizeMessageTtl,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeUuid,
} from './agent-messaging/normalize.js';
import {
  conversationMetadata,
  deliveryView,
  messageForParticipant,
  messageMetadata,
} from './agent-messaging/views.js';
import { AgentMessagingAdmin } from './agent-messaging/admin.js';
import { CallCoordinator } from './agent-messaging/call.js';
import {
  reapExpiredAgentMessagingBindingsLocked,
} from './agent-messaging/bindings.js';
import { SessionRegistry } from './agent-messaging/session.js';
import { ConferenceCoordinator } from './agent-messaging/conference.js';
import {
  conversationIncludes,
  messagingHostEligible,
  messagingHostEligibleSql,
} from './agent-messaging/eligibility.js';
import {
  hostAuthFingerprint,
  relayIdFromLeaseOwner,
  safeHashEqual,
  sessionIdFromLeaseOwner,
} from './agent-messaging/internals.js';

/*
 * Agent Messaging: the fleet message bus.
 *
 * `AgentMessagingService` is the interface every caller uses; the modules under
 * `agent-messaging/` are its implementation, imported here and re-exported where
 * they were part of the published surface. Splitting them out keeps this file
 * about orchestration rather than about string shapes and row projections.
 */

export {
  AGENT_MESSAGING_CALL_PIN_MAX_TTL_SECONDS,
  AGENT_MESSAGING_CALL_PIN_MIN_TTL_SECONDS,
  AGENT_MESSAGING_CALL_PIN_SPACE,
  AGENT_MESSAGING_CALL_PIN_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_DISPATCH_FLOOR_SECONDS,
  AGENT_MESSAGING_CONFERENCE_DISPATCH_MAX_SECONDS,
  AGENT_MESSAGING_CONFERENCE_MAX_MEMBERS,
  AGENT_MESSAGING_CONFERENCE_MAX_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_MIN_TTL_SECONDS,
  AGENT_MESSAGING_CONFERENCE_MEMBER_MESSAGE_CAP,
  AGENT_MESSAGING_CONFERENCE_TTL_SECONDS,
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_ENABLED_KEY,
  AGENT_MESSAGING_LEASE_SECONDS,
  AGENT_MESSAGING_LIST_LIMIT,
  AGENT_MESSAGING_MAILBOX_PAGE_SIZE,
  AGENT_MESSAGING_MAX_BODY_BYTES,
  AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS,
  AGENT_MESSAGING_MAX_TTL_SECONDS,
  AGENT_MESSAGING_MIN_TTL_SECONDS,
  AGENT_MESSAGING_MISSED_WINDOW_SECONDS,
  AGENT_MESSAGING_RECEIVE_FRESH_SECONDS,
  AGENT_MESSAGING_RELAY_TOKEN_SECONDS,
  AGENT_MESSAGING_WAIT_PAGE_SIZE,
} from './agent-messaging/constants.js';

export {
  type AgentMessagingDb,
  type AgentMessagingOutcome,
  type MessageDelivery,
  type RegisterMessagingSessionInput,
} from './agent-messaging/types.js';

export {
  deliveryBackoffSeconds,
  normalizeAgentAlias,
  normalizeCallPin,
  normalizeCallPinTtl,
  normalizeConferenceMaxMembers,
  normalizeConferenceTtl,
  normalizeDispatchEta,
  normalizeMessageBody,
  normalizeMessageTtl,
} from './agent-messaging/normalize.js';

export {
  reapExpiredAgentMessagingBindingsLocked,
  releaseAgentMessagingBindingsLocked,
  suspendAgentMessagingRuntimeLocked,
} from './agent-messaging/bindings.js';

export {
  messagingHostEligible,
  messagingHostEligibleSql,
} from './agent-messaging/eligibility.js';


export class AgentMessagingService {
  private readonly settings: SettingsService;
  private readonly sessions: SessionRegistry;
  private readonly call: CallCoordinator;
  private readonly conference: ConferenceCoordinator;
  private readonly admin: AgentMessagingAdmin;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
  ) {
    this.settings = new SettingsService(db);
    // The coordinator gets an explicit adapter rather than `this`, so the
    // primitives it may use stay a short, reviewable list and the service's
    // own internals stay private.
    this.sessions = new SessionRegistry({
      db,
      env,
      isEnabled: () => this.isEnabled(),
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      requireAddressLocked: (tx, id) => this.requireAddressLocked(tx, id),
      resolveAddressLocked: (tx, raw, forUpdate) => this.resolveAddressLocked(tx, raw, forUpdate),
      requireEligibleHostLocked: (tx, hostId) => this.requireEligibleHostLocked(tx, hostId),
      requireBridgeSessionLocked: (tx, sessionId, rawToken, hostId) =>
        this.requireBridgeSessionLocked(tx, sessionId, rawToken, hostId),
      authenticateBridge: (sessionId, rawToken, allowEnded) =>
        this.authenticateBridge(sessionId, rawToken, allowEnded),
      assertSessionRegistration: (session, host, engine, username, cwd, invocationKind, bridgeToken) =>
        this.assertSessionRegistration(session, host, engine, username, cwd, invocationKind, bridgeToken),
      assertSessionAddressLocked: (tx, sessionId, address) =>
        this.assertSessionAddressLocked(tx, sessionId, address),
      assertEligibleHost: (host) => this.assertEligibleHost(host),
      assertAddressRegistration: (address, host, engine, username, cwd) =>
        this.assertAddressRegistration(address, host, engine, username, cwd),
      assertAddressEligibleLocked: (tx, address) => this.assertAddressEligibleLocked(tx, address),
    });
    this.call = new CallCoordinator({
      db,
      keyring,
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      requireAddressLocked: (tx, id) => this.requireAddressLocked(tx, id),
      authenticateBridge: (sessionId, rawToken, allowEnded) =>
        this.authenticateBridge(sessionId, rawToken, allowEnded),
      assertSessionAddressLocked: (tx, sessionId, address) =>
        this.assertSessionAddressLocked(tx, sessionId, address),
      assertAddressEligibleLocked: (tx, address) => this.assertAddressEligibleLocked(tx, address),
      recordRuntime: (action, hostId, engine, details) => this.recordRuntime(action, hostId, engine, details),
    });
    this.conference = new ConferenceCoordinator({
      db,
      keyring,
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      requireAddressLocked: (tx, id) => this.requireAddressLocked(tx, id),
      resolveAddressLocked: (tx, raw, forUpdate) => this.resolveAddressLocked(tx, raw, forUpdate),
      authenticateBridge: (sessionId, rawToken, allowEnded) =>
        this.authenticateBridge(sessionId, rawToken, allowEnded),
      assertSessionAddressLocked: (tx, sessionId, address) =>
        this.assertSessionAddressLocked(tx, sessionId, address),
      assertAddressEligibleLocked: (tx, address) => this.assertAddressEligibleLocked(tx, address),
      sweepCallPinsLocked: (tx, now) => this.call.sweepCallPinsLocked(tx, now),
      livePinsLocked: (tx) => this.call.livePinsLocked(tx),
      pickFreePin: (taken) => this.call.pickFreePin(taken),
      requireConversationLocked: (tx, id) => this.requireConversationLocked(tx, id),
      cancelConversationInternal: (conversationId, canceledBy, reason, addressId, sessionId) =>
        this.cancelConversationInternal(conversationId, canceledBy, reason, addressId, sessionId),
      assertConversationParticipants: (conversation, first, second) =>
        this.assertConversationParticipants(conversation, first, second),
    });
    this.admin = new AgentMessagingAdmin({
      db,
      keyring,
      settings: this.settings,
      isEnabled: () => this.isEnabled(),
      requireEnabled: () => this.requireEnabled(),
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      requireConversationLocked: (tx, id) => this.requireConversationLocked(tx, id),
      decodeContent: (message) => this.decodeContent(message),
      cancelConversationInternal: (conversationId, canceledBy, reason, addressId, sessionId) =>
        this.cancelConversationInternal(conversationId, canceledBy, reason, addressId, sessionId),
      addressMap: (ids) => this.addressMap(ids),
      assertConversationParticipants: (conversation, first, second) =>
        this.assertConversationParticipants(conversation, first, second),
    });
  }

  async isEnabled(): Promise<boolean> {
    return await this.settings.getFlag(AGENT_MESSAGING_ENABLED_KEY, false);
  }

  async state(): Promise<Record<string, unknown>> {
    return this.admin.state();
  }

  async setEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    return this.admin.setEnabled(enabled);
  }

  async suspendHostRuntime(
    hostId: number,
    reason: 'host_inactive' | 'engine_disabled',
    engines?: Engine[],
  ): Promise<Record<string, unknown>> {
    return this.sessions.suspendHostRuntime(hostId, reason, engines);
  }

  async registerSession(host: Host, input: RegisterMessagingSessionInput): Promise<Record<string, unknown>> {
    return this.sessions.registerSession(host, input);
  }

  async heartbeatSession(
    sessionId: string,
    bridgeToken: string,
    input: {
      status?: string;
      upstreamSessionId?: string | null;
      adapterProtocol?: string | null;
      adapterCapabilities?: Record<string, unknown> | null;
      receiveCapable?: boolean;
      expectedBindingGeneration?: number | null;
      continuity?: 'native' | 'reset';
      skipIfUnbound?: boolean;
    },
  ): Promise<Record<string, unknown> | null> {
    return this.sessions.heartbeatSession(sessionId, bridgeToken, input);
  }

  async finishSession(sessionId: string, bridgeToken: string, status: 'completed' | 'failed'): Promise<Record<string, unknown>> {
    return this.sessions.finishSession(sessionId, bridgeToken, status);
  }

  async listAddresses(sessionId: string, bridgeToken: string, filters: { engine?: Engine; hostId?: number; includeOffline?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.sessions.listAddresses(sessionId, bridgeToken, filters);
  }

  // =====================================================================
  // Calls -- delegated to `CallCoordinator`, which also owns the PIN space.
  // =====================================================================

  async openCall(
    sessionId: string,
    bridgeToken: string,
    input: { ttlSeconds?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    return this.call.openCall(sessionId, bridgeToken, input);
  }

  async joinCall(
    sessionId: string,
    bridgeToken: string,
    input: { pin: string; content: string; clientMessageId: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    return this.call.joinCall(sessionId, bridgeToken, input);
  }

  // =====================================================================
  // Conferences
  //
  // Delegated to `ConferenceCoordinator`; the wire-facing names stay here so
  // no route or test has to know the room logic moved.
  // =====================================================================

  async openConference(
    sessionId: string,
    bridgeToken: string,
    input: { topic?: string | null; purpose?: string | null; ttlSeconds?: number | null; maxMembers?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    return this.conference.open(sessionId, bridgeToken, input);
  }

  async inviteToConference(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string[]; note?: string | null },
  ): Promise<Record<string, unknown>> {
    return this.conference.invite(sessionId, bridgeToken, input);
  }

  async joinConference(
    sessionId: string,
    bridgeToken: string,
    input: { pin?: string | null; conferenceId?: string | null; purpose?: string | null; content?: string | null },
  ): Promise<Record<string, unknown>> {
    return this.conference.join(sessionId, bridgeToken, input);
  }

  async conferenceRoster(sessionId: string, bridgeToken: string, conferenceId: string): Promise<Record<string, unknown>> {
    return this.conference.roster(sessionId, bridgeToken, conferenceId);
  }

  async conferenceSay(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; content: string; to?: string | null },
  ): Promise<Record<string, unknown>> {
    return this.conference.say(sessionId, bridgeToken, input);
  }

  async conferenceDispatch(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; to: string; task: string; etaSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    return this.conference.dispatch(sessionId, bridgeToken, input);
  }

  async adjournConference(
    sessionId: string,
    bridgeToken: string,
    input: { conferenceId: string; reason?: string | null; force?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.conference.adjourn(sessionId, bridgeToken, input);
  }

  async sendMessage(
    sessionId: string,
    bridgeToken: string,
    input: {
      to: string;
      content: string;
      clientMessageId: string;
      conversationId?: string | null;
      ttlSeconds?: number | null;
      kind?: 'message' | 'request';
    },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const sender = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, sender);
      const target = await this.resolveAddressLocked(tx, input.to, true);
      await this.assertAddressEligibleLocked(tx, target);
      if (sender.id === target.id) {
        throw new ValidationError('An agent cannot message itself', { param: 'to' });
      }
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      if (existing) {
        this.assertMessageIdempotency(existing, target.id, input.conversationId ?? null, null, content, input.kind ?? 'message');
        return { message: existing, sender, target, content, created: false };
      }

      const now = nowIso();
      let conversation: AgentBusConversation;
      if (input.conversationId) {
        conversation = await this.requireConversationLocked(tx, normalizeUuid(input.conversationId, 'conversation_id'));
        this.assertConversationParticipants(conversation, sender.id, target.id);
        if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      } else {
        conversation = {
          id: randomUUID(),
          addressAId: sender.id,
          addressBId: target.id,
          createdByAddressId: sender.id,
          nextSequence: 1,
          status: 'open',
          lastActivityAt: now,
          canceledBy: null,
          cancelReason: null,
          canceledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusConversations).values(conversation);
      }
      const sequence = Number(conversation.nextSequence);
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence,
        replyToMessageId: null,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: authenticated.session.id,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: input.kind ?? 'message',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(ttlSeconds),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent message could not be read back');
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      return { message: persisted, sender, target, content, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.queued', authenticated.host.id, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        source_engine: result.sender.engine,
        target_engine: result.target.engine,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        status: result.message.status,
      });
    }
    return {
      created: result.created,
      message: messageForParticipant(result.message, result.content, result.sender, result.target),
    };
  }

  async replyMessage(
    sessionId: string,
    bridgeToken: string,
    parentMessageId: string,
    input: { content: string; clientMessageId: string; ttlSeconds?: number | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const senderAddressId = authenticated.session.agentBusAddressId;
    if (!senderAddressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    const parentId = normalizeUuid(parentMessageId, 'message_id');
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const sender = await this.requireAddressLocked(tx, senderAddressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, sender);
      const parentRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, parentId)).limit(1).for('update');
      const parent = parentRows[0];
      if (!parent || parent.targetAddressId !== sender.id) {
        throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      }
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      await this.assertAddressEligibleLocked(tx, target);
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      if (existing) {
        this.assertMessageIdempotency(existing, target.id, parent.conversationId, parent.id, content, 'reply');
        return { message: existing, sender, target, content, created: false };
      }
      const conversation = await this.requireConversationLocked(tx, parent.conversationId);
      this.assertConversationParticipants(conversation, sender.id, target.id);
      if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      const now = nowIso();
      const sequence = Number(conversation.nextSequence);
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence,
        replyToMessageId: parent.id,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: authenticated.session.id,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(ttlSeconds),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent reply could not be read back');
      // An attached conference member reports by replying to its task.
      await this.conference.settleConferenceDispatchLocked(tx, parent.id, now);
      await this.conference.chargeConferenceBudgetLocked(tx, parent.conversationId, now);
      await tx.update(agentBusConversations).set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now }).where(eq(agentBusConversations.id, conversation.id));
      return { message: persisted, sender, target, content, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.replied', authenticated.host.id, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        reply_to_message_id: result.message.replyToMessageId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', { message_id: result.message.id, conversation_id: result.message.conversationId, status: 'queued' });
    }
    return { created: result.created, message: messageForParticipant(result.message, result.content, result.sender, result.target) };
  }

  async waitForMessages(
    sessionId: string,
    bridgeToken: string,
    conversationId: string,
    afterSequence = 0,
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conversationId, 'conversation_id');
    const { conversation, rows, hasMore } = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const address = await this.requireAddressLocked(tx, addressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, address);
      const conversationRows = await tx.select().from(agentBusConversations).where(eq(agentBusConversations.id, id)).limit(1).for('update');
      const conversation = conversationRows[0];
      if (!conversation || !conversationIncludes(conversation, addressId)) {
        throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      }
      const fetched = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.conversationId, id), eq(agentBusMessages.targetAddressId, addressId), gt(agentBusMessages.sequence, Math.max(0, Math.trunc(afterSequence)))))
        .orderBy(asc(agentBusMessages.sequence))
        .limit(AGENT_MESSAGING_WAIT_PAGE_SIZE + 1);
      return { conversation, rows: fetched.slice(0, AGENT_MESSAGING_WAIT_PAGE_SIZE), hasMore: fetched.length > AGENT_MESSAGING_WAIT_PAGE_SIZE };
    });
    const addresses = await this.addressMap(rows.flatMap((row) => [row.senderAddressId, row.targetAddressId]));
    return {
      conversation: conversationMetadata(conversation),
      messages: rows.map((row) => messageForParticipant(row, this.decodeContent(row), addresses.get(row.senderAddressId)!, addresses.get(row.targetAddressId)!)),
      has_more: hasMore,
      next_sequence: rows.at(-1)?.sequence ?? Math.max(0, Math.trunc(afterSequence)),
    };
  }

  async getMessage(sessionId: string, bridgeToken: string, messageId: string): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(messageId, 'message_id');
    const message = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const address = await this.requireAddressLocked(tx, addressId);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, address);
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message || (message.senderAddressId !== addressId && message.targetAddressId !== addressId)) {
        throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      }
      return message;
    });
    const addresses = await this.addressMap([message.senderAddressId, message.targetAddressId]);
    return { message: messageForParticipant(message, this.decodeContent(message), addresses.get(message.senderAddressId)!, addresses.get(message.targetAddressId)!) };
  }

  async cancelConversation(sessionId: string, bridgeToken: string, conversationId: string, reason?: string | null): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const id = normalizeUuid(conversationId, 'conversation_id');
    const result = await this.cancelConversationInternal(
      id,
      `agent:${addressId}`,
      reason ?? 'Canceled by participant',
      addressId,
      authenticated.session.id,
    );
    wsPublisher.publish('agent_messaging.conversation.changed', { conversation_id: id, status: 'canceled' });
    return result;
  }

  async claimForSession(sessionId: string, bridgeToken: string, claimId: string): Promise<MessageDelivery | null> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    if (!authenticated.session.receiveHeartbeatAt) {
      throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
    }
    return await this.claimDelivery([addressId], `session:${sessionId}`, claimId, null, false);
  }

  /**
   * Report what is waiting without touching it.
   *
   * An interactive agent has no interrupt -- it exists only during a turn -- so
   * until something tells it otherwise, a queued message simply expires unread.
   * This is the ring. Two constraints follow from that job and neither is
   * negotiable:
   *
   * - It must work *before* the agent has ever bound receive-capable, because
   *   binding happens on the first `agent_listen` and the whole point is that
   *   the agent has not listened yet. So, unlike `claimForSession`, there is no
   *   `receiveHeartbeatAt` gate here.
   * - It must leave the queue exactly as it found it: no lease, no status
   *   transition, no attempt burned. Peeking is not claiming.
   *
   * Content is deliberately omitted. Hearing the phone ring is not answering
   * it, and handing the body over without a lease would tell the sender its
   * message went unread while the target had in fact read it.
   *
   * `missed` exists because expiry is otherwise entirely invisible: today an
   * unanswered message flips to `expired` and no one ever learns a call was
   * placed at all.
   */
  async peekMailbox(sessionId: string, bridgeToken: string): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const now = nowIso();
    const missedAfter = isoOffsetSeconds(-AGENT_MESSAGING_MISSED_WINDOW_SECONDS);
    const rows = await this.db
      .select({ message: agentBusMessages, sender: agentBusAddresses, fqdn: hosts.fqdn })
      .from(agentBusMessages)
      .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentBusMessages.senderAddressId))
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(
        and(
          eq(agentBusMessages.targetAddressId, addressId),
          or(
            and(eq(agentBusMessages.status, 'queued'), gt(agentBusMessages.expiresAt, now)),
            and(eq(agentBusMessages.status, 'expired'), gt(agentBusMessages.expiredAt, missedAfter)),
          ),
        ),
      )
      .orderBy(asc(agentBusMessages.dispatchOrder))
      .limit(AGENT_MESSAGING_MAILBOX_PAGE_SIZE);
    const pending: Record<string, unknown>[] = [];
    const missed: Record<string, unknown>[] = [];
    for (const row of rows) {
      const from = {
        address: row.sender.address,
        alias: row.sender.displayAlias,
        engine: row.sender.engine,
        fqdn: row.fqdn,
      };
      if (row.message.status === 'queued') {
        pending.push({
          message_id: row.message.id,
          conversation_id: row.message.conversationId,
          kind: row.message.kind,
          from,
          expires_at: row.message.expiresAt,
        });
      } else {
        missed.push({ from, expired_at: row.message.expiredAt });
      }
    }
    return { pending, missed };
  }

  async registerRelay(
    host: Host,
    input: {
      username: string;
      instanceId: string;
      wrapperVersion: string;
      capabilities?: Record<string, unknown> | null;
    },
  ): Promise<Record<string, unknown>> {
    await this.requireEnabled();
    this.assertEligibleHost(host);
    const username = normalizeRequiredText(input.username, 'username', 255);
    const instanceId = normalizeUuid(input.instanceId, 'instance_id');
    const wrapperVersion = normalizeRequiredText(input.wrapperVersion, 'wrapper_version', 64);
    const rawToken = randomBytes(32).toString('base64url');
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(AGENT_MESSAGING_RELAY_TOKEN_SECONDS);
    const fingerprint = hostAuthFingerprint(host);
    const relay = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const lockedHost = await this.requireEligibleHostLocked(tx, host.id);
      if (!safeHashEqual(hostAuthFingerprint(lockedHost), fingerprint)) {
        throw new UnauthorizedError('Host credential changed during relay registration', 'agent_messaging_relay_host_auth_changed');
      }
      const rows = await tx
        .select()
        .from(agentBusRelays)
        .where(and(eq(agentBusRelays.hostId, host.id), eq(agentBusRelays.username, username)))
        .limit(1)
        .for('update');
      const existing = rows[0];
      if (!existing) {
        const created: AgentBusRelay = {
          id: randomUUID(),
          hostId: host.id,
          username,
          instanceId,
          generation: 1,
          tokenHash: sha256(rawToken),
          tokenExpiresAt: expiresAt,
          hostAuthFingerprint: fingerprint,
          wrapperVersion,
          capabilities: input.capabilities ?? null,
          status: 'active',
          heartbeatAt: now,
          stopRequestedAt: null,
          stoppedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await tx.insert(agentBusRelays).values(created);
        return created;
      }
      const generation = existing.generation + 1;
      await tx
        .update(agentBusRelays)
        .set({
          instanceId,
          generation,
          tokenHash: sha256(rawToken),
          tokenExpiresAt: expiresAt,
          hostAuthFingerprint: fingerprint,
          wrapperVersion,
          capabilities: input.capabilities ?? null,
          status: 'active',
          heartbeatAt: now,
          stopRequestedAt: null,
          stoppedAt: null,
          updatedAt: now,
        })
        .where(eq(agentBusRelays.id, existing.id));
      return { ...existing, instanceId, generation, tokenExpiresAt: expiresAt, status: 'active' };
    });
    wsPublisher.publish('agent_messaging.relay.changed', { relay_id: relay.id, host_id: host.id, status: 'active' });
    return {
      enabled: true,
      relay_id: relay.id,
      generation: relay.generation,
      relay_token: rawToken,
      expires_at: expiresAt,
      poll_seconds: 25,
    };
  }

  async heartbeatRelay(relayId: string, rawToken: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const now = nowIso();
    const expiresAt = isoOffsetSeconds(AGENT_MESSAGING_RELAY_TOKEN_SECONDS);
    await this.db
      .update(agentBusRelays)
      .set({ heartbeatAt: now, tokenExpiresAt: expiresAt, updatedAt: now })
      .where(and(eq(agentBusRelays.id, relay.id), eq(agentBusRelays.generation, relay.generation)));
    return { enabled: true, generation: relay.generation, expires_at: expiresAt, stop_requested: false };
  }

  async stopRelay(relayId: string, rawToken: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const now = nowIso();
    await this.db
      .update(agentBusRelays)
      .set({ status: 'stopped', tokenHash: null, tokenExpiresAt: null, stoppedAt: now, updatedAt: now })
      .where(and(eq(agentBusRelays.id, relay.id), eq(agentBusRelays.generation, relay.generation)));
    wsPublisher.publish('agent_messaging.relay.changed', { relay_id: relay.id, host_id: relay.hostId, status: 'stopped' });
    return { stopped: true };
  }

  async claimForRelay(relayId: string, rawToken: string, claimId: string): Promise<MessageDelivery | null> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const rows = await this.db
      .select({ id: agentBusAddresses.id, engine: agentBusAddresses.engine, hostEngines: hosts.engines })
      .from(agentBusAddresses)
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(and(
        eq(agentBusAddresses.hostId, relay.hostId),
        eq(agentBusAddresses.username, relay.username),
        eq(agentBusAddresses.enabled, 1),
        isNull(agentBusAddresses.archivedAt),
        messagingHostEligibleSql(),
        isNull(agentBusAddresses.currentSessionId),
      ));
    if (rows.length === 0) return null;
    const eligible = rows.filter((row) => hostEnginesList(row.hostEngines).includes(row.engine as Engine));
    if (eligible.length === 0) return null;
    return await this.claimDelivery(eligible.map((row) => row.id), `relay:${relay.id}:${relay.generation}`, claimId, relay.generation, true);
  }

  async renewSessionDelivery(sessionId: string, bridgeToken: string, messageId: string, claimId: string): Promise<Record<string, unknown>> {
    await this.authenticateBridge(sessionId, bridgeToken);
    return await this.renewDelivery(messageId, claimId, `session:${sessionId}`, null);
  }

  async renewRelayDelivery(relayId: string, rawToken: string, messageId: string, claimId: string): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    return await this.renewDelivery(
      messageId,
      claimId,
      `relay:${relay.id}:${relay.generation}`,
      relay.generation,
    );
  }

  async acknowledgeSessionDelivery(
    sessionId: string,
    bridgeToken: string,
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    return await this.acknowledgeDelivery(messageId, input, `session:${sessionId}`, null, authenticated.session.id);
  }

  async acknowledgeRelayDelivery(
    relayId: string,
    rawToken: string,
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; deliverySessionId?: string | null; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
  ): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    return await this.acknowledgeDelivery(
      messageId,
      input,
      `relay:${relay.id}:${relay.generation}`,
      relay.generation,
      input.deliverySessionId ?? null,
    );
  }

  async replyFromRelayDelivery(
    relayId: string,
    rawToken: string,
    parentMessageId: string,
    input: {
      claimId: string;
      content: string;
      clientMessageId: string;
      deliverySessionId?: string | null;
      upstreamSessionId?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const relay = await this.authenticateRelay(relayId, rawToken);
    const parentId = normalizeUuid(parentMessageId, 'message_id');
    const claimId = normalizeUuid(input.claimId, 'claim_id');
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const deliverySessionId = input.deliverySessionId
      ? normalizeUuid(input.deliverySessionId, 'delivery_session_id')
      : null;
    const upstreamSessionId = normalizeOptionalText(input.upstreamSessionId, 255);
    const content = normalizeMessageBody(input.content);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      await this.requireRelayGenerationLocked(tx, relay.id, relay.generation);
      const parentRows = await tx
        .select()
        .from(agentBusMessages)
        .where(eq(agentBusMessages.id, parentId))
        .limit(1)
        .for('update');
      const parent = parentRows[0];
      const leaseOwner = `relay:${relay.id}:${relay.generation}`;
      if (
        !parent ||
        parent.leaseOwner !== leaseOwner ||
        parent.claimId !== claimId ||
        parent.relayGeneration !== relay.generation ||
        (parent.status !== 'leased' && parent.status !== 'accepted')
      ) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      const sender = await this.requireAddressLocked(tx, parent.targetAddressId);
      if (sender.hostId !== relay.hostId || sender.username !== relay.username) {
        throw new ForbiddenError('Relay does not own this delivery address', 'agent_messaging_relay_target_mismatch');
      }
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      await this.assertAddressEligibleLocked(tx, target);
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.replyToMessageId, parent.id), eq(agentBusMessages.senderAddressId, sender.id)))
        .limit(1)
        .for('update');
      if (existingRows[0]) {
        return { message: existingRows[0], sender, target, created: false };
      }
      const conversation = await this.requireConversationLocked(tx, parent.conversationId);
      this.assertConversationParticipants(conversation, sender.id, target.id);
      if (conversation.status !== 'open') {
        throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      }
      const now = nowIso();
      const messageId = randomUUID();
      const message: typeof agentBusMessages.$inferInsert = {
        id: messageId,
        conversationId: conversation.id,
        sequence: Number(conversation.nextSequence),
        replyToMessageId: parent.id,
        redriveOfMessageId: null,
        senderAddressId: sender.id,
        senderSessionId: deliverySessionId,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        contentEnc: encrypt(content, this.keyring),
        contentBytes: Buffer.byteLength(content, 'utf8'),
        clientMessageId,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        claimId: null,
        relayGeneration: null,
        targetBindingGeneration: null,
        deliverySessionId: null,
        deliveryUpstreamSessionId: null,
        expiresAt: isoOffsetSeconds(AGENT_MESSAGING_DEFAULT_TTL_SECONDS),
        lastErrorCode: null,
        lastErrorEnc: null,
        cancelRequestedAt: null,
        acceptedAt: null,
        completedAt: null,
        ambiguousAt: null,
        deadAt: null,
        expiredAt: null,
        canceledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(agentBusMessages).values(message);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted relay reply could not be read back');
      // A headless conference member never calls a tool: the relay correlates
      // its final output and posts it here, so this is where its dispatch ends.
      await this.conference.settleConferenceDispatchLocked(tx, parent.id, now);
      await this.conference.chargeConferenceBudgetLocked(tx, parent.conversationId, now);
      await tx
        .update(agentBusConversations)
        .set({ nextSequence: persisted.sequence + 1, lastActivityAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversation.id));
      await tx
        .update(agentBusMessages)
        .set({ deliverySessionId, deliveryUpstreamSessionId: upstreamSessionId, updatedAt: now })
        .where(eq(agentBusMessages.id, parent.id));
      return { message: persisted, sender, target, created: true };
    });
    if (result.created) {
      await this.recordRuntime('agent_message.replied', relay.hostId, result.sender.engine, {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        reply_to_message_id: parentId,
        source_address_id: result.sender.id,
        target_address_id: result.target.id,
        content_bytes: result.message.contentBytes,
      });
      wsPublisher.publish('agent_messaging.message.changed', {
        message_id: result.message.id,
        conversation_id: result.message.conversationId,
        status: 'queued',
      });
    }
    return { created: result.created, message: messageMetadata(result.message, result.sender, result.target) };
  }

  // =====================================================================
  // Admin console surface -- delegated to `AgentMessagingAdmin`.
  // =====================================================================

  async listAdminAddresses(): Promise<Record<string, unknown>> {
    return this.admin.listAdminAddresses();
  }

  async setAddressAlias(addressId: string, displayAlias: string | null): Promise<Record<string, unknown>> {
    return this.admin.setAddressAlias(addressId, displayAlias);
  }

  async setAddressEnabled(addressId: string, enabled: boolean): Promise<Record<string, unknown>> {
    return this.admin.setAddressEnabled(addressId, enabled);
  }

  async listAdminConversations(options: { status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.admin.listAdminConversations(options);
  }

  async listAdminMessages(options: { conversationId?: string; status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.admin.listAdminMessages(options);
  }

  async revealMessage(messageId: string): Promise<Record<string, unknown>> {
    return this.admin.revealMessage(messageId);
  }

  async adminCancelConversation(conversationId: string, reason?: string | null): Promise<Record<string, unknown>> {
    return this.admin.adminCancelConversation(conversationId, reason);
  }

  async redriveMessage(messageId: string): Promise<Record<string, unknown>> {
    return this.admin.redriveMessage(messageId);
  }

  async maintenance(): Promise<Record<string, number>> {
    const now = nowIso();
    const staleRelay = isoOffsetSeconds(-2 * AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      const releasedBindings = await reapExpiredAgentMessagingBindingsLocked(tx, now);
      // Expired PINs are also swept at mint and redeem time; doing it here as
      // well means a PIN nobody ever dials does not squat its slot in the unique
      // index until the next `#call` happens to run.
      await this.call.sweepCallPinsLocked(tx, now);
      const expiring = await tx.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      const retryable = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      const exhausted = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      const uncertain = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), lte(agentBusMessages.leaseUntil, now)));
      await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'dead', deadAt: now, lastErrorCode: 'delivery_attempts_exhausted', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      await tx.update(agentBusMessages).set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'accepted_lease_lost', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'accepted'), lte(agentBusMessages.leaseUntil, now)));
      await tx.update(agentBusRelays).set({ status: 'stale', updatedAt: now }).where(and(eq(agentBusRelays.status, 'active'), lte(agentBusRelays.heartbeatAt, staleRelay)));
      const conferences = await this.conference.sweepConferencesLocked(tx, now);
      return {
        expired: Number(expiring[0]?.value ?? 0),
        retried: Number(retryable[0]?.value ?? 0),
        dead: Number(exhausted[0]?.value ?? 0),
        ambiguous: Number(uncertain[0]?.value ?? 0),
        released_bindings: releasedBindings,
        ...conferences,
      };
    });
    if (result.expired || result.retried || result.dead || result.ambiguous || result.released_bindings) wsPublisher.publish('agent_messaging.queue.changed', result);
    if (result.conferences_adjourned || result.dispatches_expired) {
      wsPublisher.publish('agent_messaging.conference.changed', {
        adjourned: result.conferences_adjourned,
        dispatches_expired: result.dispatches_expired,
      });
    }
    return result;
  }


  private async claimDelivery(
    targetAddressIds: string[],
    leaseOwner: string,
    rawClaimId: string,
    relayGeneration: number | null,
    skipReceiveCapable: boolean,
  ): Promise<MessageDelivery | null> {
    const claimId = normalizeUuid(rawClaimId, 'claim_id');
    const now = nowIso();
    const leaseUntil = isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS);
    const receiveFreshAfter = isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      } else {
        const sessionId = sessionIdFromLeaseOwner(leaseOwner);
        if (!sessionId) throw new ConflictError('Session lease owner is invalid', 'agent_messaging_lease_lost');
        const sessionRows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
        const session = sessionRows[0];
        if (!session?.agentBusAddressId || !targetAddressIds.includes(session.agentBusAddressId)) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
        const target = await this.requireAddressLocked(tx, session.agentBusAddressId);
        await this.assertSessionAddressLocked(tx, sessionId, target);
        if (!session.receiveHeartbeatAt || session.receiveHeartbeatAt <= receiveFreshAfter) {
          throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
        }
      }
      await tx
        .update(agentBusMessages)
        .set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), inArray(agentBusMessages.status, ['queued', 'leased']), lte(agentBusMessages.expiresAt, now)));
      await tx
        .update(agentBusMessages)
        .set({ status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.expiresAt, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      await tx
        .update(agentBusMessages)
        .set({ status: 'dead', deadAt: now, lastErrorCode: 'delivery_attempts_exhausted', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));

      const replayRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), eq(agentBusMessages.leaseOwner, leaseOwner), eq(agentBusMessages.claimId, claimId), eq(agentBusMessages.status, 'leased')))
        .limit(1)
        .for('update');
      if (replayRows[0]) {
        const target = await this.requireAddressLocked(tx, replayRows[0].targetAddressId);
        const sender = await this.requireAddressLocked(tx, replayRows[0].senderAddressId);
        return { message: replayRows[0], sender, target };
      }

      const candidates = await tx
        .select()
        .from(agentBusMessages)
        .where(and(
          inArray(agentBusMessages.targetAddressId, targetAddressIds),
          eq(agentBusMessages.status, 'queued'),
          lte(agentBusMessages.nextAttemptAt, now),
          gt(agentBusMessages.expiresAt, now),
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS earlier
             WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
               AND earlier.status IN ('queued', 'leased', 'accepted')
               AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder}
          )`,
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS in_flight
             WHERE in_flight.target_address_id = ${agentBusMessages.targetAddressId}
               AND in_flight.status IN ('leased', 'accepted')
               AND in_flight.id <> ${agentBusMessages.id}
          )`,
        ))
        .orderBy(asc(agentBusMessages.dispatchOrder))
        .limit(64)
        .for('update');
      for (const candidate of candidates) {
        const target = await this.requireAddressLocked(tx, candidate.targetAddressId);
        await this.assertAddressEligibleLocked(tx, target);
        // A relay must never write to a native upstream session while its
        // interactive wrapper is still attached. Receive-capable sessions
        // claim live; non-channel sessions leave work queued until they exit.
        if (skipReceiveCapable && target.currentSessionId) continue;
        const attempts = candidate.attempts + 1;
        await tx
          .update(agentBusMessages)
          .set({
            status: 'leased',
            attempts,
            leaseOwner,
            leaseUntil,
            claimId,
            relayGeneration,
            targetBindingGeneration: target.bindingGeneration,
            deliverySessionId: target.currentSessionId,
            deliveryUpstreamSessionId: target.lastUpstreamSessionId,
            updatedAt: now,
          })
          .where(and(eq(agentBusMessages.id, candidate.id), eq(agentBusMessages.status, 'queued')));
        const sender = await this.requireAddressLocked(tx, candidate.senderAddressId);
        return {
          message: {
            ...candidate,
            status: 'leased',
            attempts,
            leaseOwner,
            leaseUntil,
            claimId,
            relayGeneration,
            targetBindingGeneration: target.bindingGeneration,
            deliverySessionId: target.currentSessionId,
            deliveryUpstreamSessionId: target.lastUpstreamSessionId,
            updatedAt: now,
          },
          sender,
          target,
        };
      }
      return null;
    });
    if (!result) return null;
    return deliveryView(result.message, this.decodeContent(result.message), result.sender, result.target);
  }

  private async renewDelivery(
    messageId: string,
    rawClaimId: string,
    leaseOwner: string,
    relayGeneration: number | null,
  ): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const claimId = normalizeUuid(rawClaimId, 'claim_id');
    const now = nowIso();
    const leaseUntil = isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS);
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      }
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message || (message.status !== 'leased' && message.status !== 'accepted') || message.leaseOwner !== leaseOwner || message.claimId !== claimId) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      const sessionId = sessionIdFromLeaseOwner(leaseOwner);
      if (sessionId) {
        const target = await this.requireAddressLocked(tx, message.targetAddressId);
        await this.assertSessionAddressLocked(tx, sessionId, target);
        if (message.targetBindingGeneration !== target.bindingGeneration) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      if (message.expiresAt <= now && message.status !== 'accepted') {
        await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }).where(eq(agentBusMessages.id, id));
        throw new ConflictError('Message expired', 'agent_messaging_message_expired');
      }
      await tx.update(agentBusMessages).set({ leaseUntil, updatedAt: now }).where(eq(agentBusMessages.id, id));
      return message;
    });
    return { message_id: result.id, lease_until: leaseUntil };
  }

  private async acknowledgeDelivery(
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
    leaseOwner: string,
    relayGeneration: number | null,
    deliverySessionId: string | null,
  ): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const claimId = normalizeUuid(input.claimId, 'claim_id');
    const errorCode = normalizeErrorCode(input.errorCode);
    const errorText = normalizeOptionalText(input.error, 4096);
    const upstreamSessionId = normalizeOptionalText(input.upstreamSessionId, 255);
    const now = nowIso();
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      }
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const message = rows[0];
      if (!message) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      if (message.leaseOwner !== leaseOwner || message.claimId !== claimId || (relayGeneration != null && message.relayGeneration !== relayGeneration)) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      if (TERMINAL_MESSAGE_STATUSES.includes(message.status as (typeof TERMINAL_MESSAGE_STATUSES)[number])) {
        return message;
      }
      if (input.outcome === 'accepted' && message.status === 'accepted') return message;
      if (input.outcome === 'accepted' && message.status !== 'leased') {
        throw new ConflictError('Only a leased message can be accepted', 'agent_messaging_ack_invalid');
      }
      if (input.outcome === 'retry' && message.status === 'accepted') {
        throw new ConflictError('Accepted delivery cannot be retried safely', 'agent_messaging_ack_invalid');
      }
      if (relayGeneration == null && deliverySessionId) {
        const target = await this.requireAddressLocked(tx, message.targetAddressId);
        await this.assertSessionAddressLocked(tx, deliverySessionId, target);
        if (message.targetBindingGeneration !== target.bindingGeneration) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
      }
      const shared = {
        deliverySessionId: deliverySessionId ?? message.deliverySessionId,
        deliveryUpstreamSessionId: upstreamSessionId ?? message.deliveryUpstreamSessionId,
        lastErrorCode: errorCode,
        lastErrorEnc: errorText ? encrypt(errorText, this.keyring) : null,
        updatedAt: now,
      };
      let patch: Partial<typeof agentBusMessages.$inferInsert>;
      switch (input.outcome) {
        case 'accepted':
          patch = { ...shared, status: 'accepted', acceptedAt: message.acceptedAt ?? now, leaseUntil: isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS) };
          break;
        case 'completed':
          // Retain the terminal claim identity so an acknowledgement whose
          // response was lost can be retried idempotently. Terminal rows are
          // excluded from every in-flight query, so this is not a live lease.
          patch = { ...shared, status: 'completed', acceptedAt: message.acceptedAt ?? now, completedAt: now, leaseUntil: null };
          break;
        case 'ambiguous':
          patch = { ...shared, status: 'ambiguous', ambiguousAt: now, leaseUntil: null };
          break;
        case 'dead':
          patch = { ...shared, status: 'dead', deadAt: now, leaseUntil: null };
          break;
        case 'retry':
          patch = message.attempts >= AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS
            ? { ...shared, status: 'dead', deadAt: now, lastErrorCode: errorCode ?? 'delivery_attempts_exhausted', leaseUntil: null }
            : { ...shared, status: 'queued', nextAttemptAt: isoOffsetSeconds(deliveryBackoffSeconds(message.attempts)), leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null };
          break;
      }
      await tx.update(agentBusMessages).set(patch).where(eq(agentBusMessages.id, id));
      if (upstreamSessionId && input.outcome !== 'retry' && input.outcome !== 'dead') {
        const targetRows = await tx
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, message.targetAddressId))
          .limit(1)
          .for('update');
        const target = targetRows[0];
        if (target) {
          await tx
            .update(agentBusAddresses)
            .set({
              lastUpstreamSessionId: upstreamSessionId,
              continuity: 'native',
              readiness: target.currentSessionId ? target.readiness : 'resumable',
              lastSeenAt: now,
              updatedAt: now,
            })
            .where(eq(agentBusAddresses.id, target.id));
        }
      }
      return { ...message, ...patch } as AgentBusMessage;
    });
    const targetRows = await this.db.select({ hostId: agentBusAddresses.hostId }).from(agentBusAddresses).where(eq(agentBusAddresses.id, result.targetAddressId)).limit(1);
    const action = result.status === 'completed' ? 'agent_message.completed' : result.status === 'dead' ? 'agent_message.dead' : result.status === 'ambiguous' ? 'agent_message.ambiguous' : 'agent_message.delivery';
    await this.recordRuntime(action, targetRows[0]?.hostId ?? null, result.targetEngine, {
      message_id: result.id,
      conversation_id: result.conversationId,
      status: result.status,
      attempts: result.attempts,
      error_code: result.lastErrorCode,
    });
    wsPublisher.publish('agent_messaging.message.changed', { message_id: result.id, conversation_id: result.conversationId, status: result.status });
    return { message: messageMetadata(result) };
  }

  private async cancelConversationInternal(
    conversationId: string,
    canceledBy: string,
    reason: string,
    participantAddressId?: string,
    participantSessionId?: string,
  ): Promise<Record<string, unknown>> {
    const now = nowIso();
    return await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (participantAddressId && participantSessionId) {
        const address = await this.requireAddressLocked(tx, participantAddressId);
        await this.assertSessionAddressLocked(tx, participantSessionId, address);
      }
      const conversation = await this.requireConversationLocked(tx, conversationId);
      if (participantAddressId && !conversationIncludes(conversation, participantAddressId)) {
        throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
      }
      if (conversation.status === 'canceled') return { conversation: conversationMetadata(conversation), canceled_messages: 0 };
      const [rows, uncertain] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.conversationId, conversationId), inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]))),
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.conversationId, conversationId), eq(agentBusMessages.status, 'accepted'))),
      ]);
      await tx
        .update(agentBusConversations)
        .set({ status: 'canceled', canceledBy: normalizeOptionalText(canceledBy, 191), cancelReason: normalizeOptionalText(reason, 255), canceledAt: now, updatedAt: now })
        .where(eq(agentBusConversations.id, conversationId));
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.conversationId, conversationId), inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES])));
      await tx
        .update(agentBusMessages)
        .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'conversation_canceled_after_accept', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.conversationId, conversationId), eq(agentBusMessages.status, 'accepted')));
      return {
        conversation: { ...conversationMetadata(conversation), status: 'canceled', canceled_at: now },
        canceled_messages: Number(rows[0]?.value ?? 0),
        ambiguous_messages: Number(uncertain[0]?.value ?? 0),
      };
    });
  }

  private async authenticateBridge(sessionId: string, rawToken: string, allowEnded = false): Promise<{ session: AgentSession; host: Host }> {
    await this.requireEnabled();
    const id = normalizeUuid(sessionId, 'session_id');
    const rows = await this.db
      .select({ session: agentSessions, host: hosts })
      .from(agentSessions)
      .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
      .where(eq(agentSessions.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || !safeHashEqual(sha256(rawToken ?? ''), row.session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    this.assertEligibleHost(row.host);
    if (!safeHashEqual(hostAuthFingerprint(row.host), row.session.hostAuthFingerprint)) {
      throw new UnauthorizedError('Agent bridge host credential changed', 'agent_bridge_host_auth_changed');
    }
    if (!hostEnginesList(row.host.engines).includes(row.session.engine as Engine)) {
      throw new ForbiddenError(`Engine ${row.session.engine} is disabled for this host`, 'engine_disabled');
    }
    if (row.session.endedAt && !allowEnded) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    if (!row.session.endedAt && row.session.bridgeExpiresAt <= nowIso()) throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
    return row;
  }

  private async authenticateRelay(relayId: string, rawToken: string): Promise<AgentBusRelay> {
    await this.requireEnabled();
    const id = normalizeUuid(relayId, 'relay_id');
    const rows = await this.db
      .select({ relay: agentBusRelays, host: hosts })
      .from(agentBusRelays)
      .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
      .where(eq(agentBusRelays.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.relay.status !== 'active' || !row.relay.tokenHash || !safeHashEqual(sha256(rawToken ?? ''), row.relay.tokenHash)) {
      throw new UnauthorizedError('Invalid agent relay credential', 'agent_messaging_relay_unauthorized');
    }
    this.assertEligibleHost(row.host);
    if (row.relay.tokenExpiresAt == null || row.relay.tokenExpiresAt <= nowIso()) throw new UnauthorizedError('Agent relay credential expired', 'agent_messaging_relay_expired');
    if (!safeHashEqual(hostAuthFingerprint(row.host), row.relay.hostAuthFingerprint)) throw new UnauthorizedError('Agent relay host credential changed', 'agent_messaging_relay_host_auth_changed');
    return row.relay;
  }

  private async requireBridgeSessionLocked(db: AgentMessagingDb, sessionId: string, rawToken: string, hostId: number): Promise<AgentSession> {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    const session = rows[0];
    if (!session || session.hostId !== hostId || !safeHashEqual(sha256(rawToken ?? ''), session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    if (session.endedAt) throw new ConflictError('Agent session is finished', 'agent_session_finished');
    return session;
  }

  private async requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress> {
    const rows = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1).for('update');
    const address = rows[0];
    if (!address) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    return address;
  }

  private async resolveAddressLocked(db: AgentMessagingDb, raw: string, forUpdate: boolean): Promise<AgentBusAddress> {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) throw new ValidationError('to is required', { param: 'to' });
    const query = db
      .select()
      .from(agentBusAddresses)
      .where(or(eq(agentBusAddresses.address, value), eq(agentBusAddresses.displayAlias, value)))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    const address = rows[0];
    if (!address || address.archivedAt || address.enabled !== 1) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
    return address;
  }

  private async requireConversationLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConversation> {
    const rows = await db.select().from(agentBusConversations).where(eq(agentBusConversations.id, id)).limit(1).for('update');
    const conversation = rows[0];
    if (!conversation) throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
    return conversation;
  }

  private async assertAddressEligibleLocked(db: AgentMessagingDb, address: AgentBusAddress): Promise<void> {
    if (address.enabled !== 1 || address.archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    const rows = await db.select().from(hosts).where(eq(hosts.id, address.hostId)).limit(1).for('update');
    if (!rows[0] || !messagingHostEligible(rows[0])) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
    if (!hostEnginesList(rows[0].engines).includes(address.engine as Engine)) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
  }

  private assertEligibleHost(host: Host): void {
    if (!messagingHostEligible(host)) {
      throw new ForbiddenError(
        host.secure === 1
          ? 'Agent Messaging requires an active host'
          : 'Agent Messaging on an insecure host requires an open allowed window',
        host.secure === 1 ? 'agent_messaging_host_ineligible' : 'agent_messaging_insecure_window_closed',
      );
    }
  }

  private assertSessionRegistration(
    session: AgentSession,
    host: Host,
    engine: Engine,
    username: string,
    cwd: string,
    invocationKind: string,
    bridgeToken: string,
  ): void {
    if (
      session.hostId !== host.id ||
      session.engine !== engine ||
      session.username !== username ||
      session.cwd !== cwd ||
      session.invocationKind !== invocationKind ||
      !safeHashEqual(sha256(bridgeToken), session.bridgeTokenHash)
    ) {
      throw new ConflictError('Agent session registration conflicts with an existing session', 'agent_session_conflict');
    }
  }

  private assertAddressRegistration(address: AgentBusAddress, host: Host, engine: Engine, username: string, cwd: string): void {
    if (address.hostId !== host.id || address.engine !== engine || address.username !== username || address.cwd !== cwd || address.archivedAt || address.enabled !== 1) {
      throw new ForbiddenError('Agent address cannot be rebound by this lifecycle', 'agent_messaging_address_mismatch');
    }
  }

  private assertConversationParticipants(conversation: AgentBusConversation, first: string, second: string): void {
    if (!conversationIncludes(conversation, first) || !conversationIncludes(conversation, second) || first === second) {
      throw new NotFoundError('Conversation not found', 'agent_messaging_conversation_not_found');
    }
  }

  private assertMessageIdempotency(
    row: AgentBusMessage,
    targetAddressId: string,
    conversationId: string | null,
    replyToMessageId: string | null,
    content: string,
    kind: string,
  ): void {
    if (
      row.targetAddressId !== targetAddressId ||
      (conversationId != null && row.conversationId !== conversationId) ||
      row.replyToMessageId !== replyToMessageId ||
      row.kind !== kind ||
      this.decodeContent(row) !== content
    ) {
      throw new ConflictError('client_message_id was already used for different content', 'agent_messaging_client_message_id_conflict');
    }
  }

  private decodeContent(message: Pick<AgentBusMessage, 'contentEnc'>): string {
    return decrypt(message.contentEnc, this.keyring);
  }

  private async addressMap(ids: string[]): Promise<Map<string, AgentBusAddress>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select().from(agentBusAddresses).where(inArray(agentBusAddresses.id, unique));
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.isEnabled())) throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
  }

  private async requireEnabledLocked(db: AgentMessagingDb): Promise<void> {
    const rows = await db
      .select({ version: versions.version })
      .from(versions)
      .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY))
      .limit(1)
      .for('update');
    if (!isTruthyFlagValue(rows[0]?.version, false)) {
      throw new ServiceUnavailableError('Agent Messaging is disabled', 'agent_messaging_disabled');
    }
  }

  private async requireEligibleHostLocked(db: AgentMessagingDb, hostId: number): Promise<Host> {
    const rows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1).for('update');
    const host = rows[0];
    if (!host) throw new NotFoundError('Host not found', 'host_not_found');
    this.assertEligibleHost(host);
    return host;
  }

  private async requireRelayGenerationLocked(
    db: AgentMessagingDb,
    relayId: string,
    generation: number,
  ): Promise<AgentBusRelay> {
    const rows = await db.select().from(agentBusRelays).where(eq(agentBusRelays.id, relayId)).limit(1).for('update');
    const relay = rows[0];
    if (!relay || relay.status !== 'active' || relay.generation !== generation) {
      throw new ConflictError('Agent relay generation changed', 'agent_messaging_lease_lost');
    }
    return relay;
  }

  private async assertSessionAddressLocked(
    db: AgentMessagingDb,
    sessionId: string,
    address: AgentBusAddress,
  ): Promise<void> {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    const session = rows[0];
    if (
      !session ||
      session.endedAt ||
      session.agentBusAddressId !== address.id ||
      address.currentSessionId !== sessionId ||
      address.enabled !== 1 ||
      address.archivedAt
    ) {
      throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
    }
    await this.assertAddressEligibleLocked(db, address);
  }

  private async recordRuntime(action: string, hostId: number | null, engine: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId,
      action,
      details: JSON.stringify(details),
      engine,
      createdAt: nowIso(),
    });
  }
}


export function createAgentMessagingService(db: Database, env: Env, keyring: Keyring): AgentMessagingService {
  return new AgentMessagingService(db, env, keyring);
}

