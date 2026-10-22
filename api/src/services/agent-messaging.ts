import { isEngine } from '../util/engine.js';
import { quotaRecoveryAllowed } from './quota-observation.js';
import { preparePeerBatch, presentationOrder } from './agent-messaging/peer-batch.js';
import { ApiError } from '../http/errors.js';
import { activeRolesForAddresses, roleLabelsForAddress } from './roles/assignments.js';
import { newQueuedMessage } from './agent-messaging/views.js';
import { queuePolicy, assertQueuePolicyReplay, validateRelatedWork, smartQueueAllowed, peerBatchAllowed, prepareSmartDigest, restoreUnpresentedDigests, presentDigest, coalescePendingRepeats, type QueuePolicy } from './agent-messaging/smart-queue.js';
import { WORKFLOWS_MIN_CXX_VERSION } from './managed-workflows-skill.js';
import { compareWrapperVersions, hostRunningWrapperVersion } from './wrapper-rollout.js';
import { expireRebootHandoffs } from './reboot-handoffs.js';
import { daemonAccepting, daemonResidentFor } from './host-daemon/policy.js';
import { assertHousekeepingAvailable } from './session-housekeeping.js';
import { hostDaemons, hostDaemonSessions } from '../db/schema.js';
import { discardPresenceNotices, queuePresenceNotices, recipientSnapshot } from './agent-messaging/presence-feedback.js';
import { retireRoutineNotice, retireRoutineNotices } from './agent-messaging/routine-notices.js';
import { relayDigestRecoveryPending, relayDigestRecoveryTargets, restoreRelayDigests } from './agent-messaging/relay-digests.js';
import { idleSessionPoll } from './agent-messaging/idle-session.js';
import { type AgentDiscoveryFilters } from './agent-messaging/discovery.js';
import { translateAgent } from './agent-messaging/names.js';
import { listHostInventory, type HostInventoryFilters } from './agent-messaging/host-inventory.js';
import { jsonRecord } from './agent-messaging/normalize.js';
import { agentFreshStartGrants, agentTaskResults } from '../db/schema.js';
import { storeTaskResult, queueTaskResultReply, unknownTaskResult, approveFreshStart, freshStartAllowed, taskResultSchema, type TaskResult } from './agent-messaging/task-execution.js';
import { receiverReady, receiverState } from './agent-receiver-state.js';
import type { WatchdogFailure } from './watchdog-lifecycle.js';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  agentWatchdogs,
  agentScheduleRuns,
  agentSchedules,
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  agentNameLeases,
  agentEvents,
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
import { activeHostEngines, assertHostEngineEnabled } from './host-engine-policy.js';
import { readFleetEngineState } from './engine-switch.js';
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
import { AgentMessagingConferenceAdmin, type ConferencePageOptions } from './agent-messaging/conference-admin.js';
import { AgentMessagingAdmin } from './agent-messaging/admin.js';
import {
  reapExpiredAgentMessagingBindingsLocked,
} from './agent-messaging/bindings.js';
import { SessionRegistry } from './agent-messaging/session.js';
import { agentSessionFinishedError } from './agent-session-finished.js';
import { ConferenceCoordinator } from './agent-messaging/conference.js';
import { AgentMessagingGroups, SERVER_ADDRESS_ID } from './agent-messaging/groups.js';
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
  dispatchGraceSeconds,
  normalizeAgentAlias,
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
  private readonly conference: ConferenceCoordinator;
  private readonly admin: AgentMessagingAdmin;
  private readonly conferenceAdmin: AgentMessagingConferenceAdmin;
  private readonly groups: AgentMessagingGroups;

  constructor(
    private readonly db: Database,
    private readonly env: Env,
    private readonly keyring: Keyring,
  ) {
    this.settings = new SettingsService(db);
    this.groups = new AgentMessagingGroups({
      db, keyring,
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      authenticateBridge: (sessionId, token) => this.authenticateBridge(sessionId, token),
      requireAddressLocked: (tx, id) => this.requireAddressLocked(tx, id),
      assertSessionAddressLocked: (tx, sessionId, address) => this.assertSessionAddressLocked(tx, sessionId, address),
      assertAddressEligibleLocked: (tx, address) => this.assertAddressEligibleLocked(tx, address),
    });
    // The coordinator gets an explicit adapter rather than `this`, so the
    // primitives it may use stay a short, reviewable list and the service's
    // own internals stay private.
    this.sessions = new SessionRegistry({
      db,
      env,
      keyring,
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
    this.conference = new ConferenceCoordinator({
      db,
      keyring,
      presenceFreshSeconds: env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS,
      requireEnabledLocked: (tx) => this.requireEnabledLocked(tx),
      requireAddressLocked: (tx, id) => this.requireAddressLocked(tx, id),
      resolveAddressLocked: (tx, raw, forUpdate) => this.resolveAddressLocked(tx, raw, forUpdate),
      authenticateBridge: (sessionId, rawToken, allowEnded) =>
        this.authenticateBridge(sessionId, rawToken, allowEnded),
      assertSessionAddressLocked: (tx, sessionId, address) =>
        this.assertSessionAddressLocked(tx, sessionId, address),
      assertAddressEligibleLocked: (tx, address) => this.assertAddressEligibleLocked(tx, address),
      requireConversationLocked: (tx, id) => this.requireConversationLocked(tx, id),
      cancelConversationInternal: (conversationId, canceledBy, reason, addressId, sessionId) =>
        this.cancelConversationInternal(conversationId, canceledBy, reason, addressId, sessionId),
      assertConversationParticipants: (conversation, first, second) =>
        this.assertConversationParticipants(conversation, first, second),
    });
    this.conferenceAdmin = new AgentMessagingConferenceAdmin({ db, decodeContent: (message) => this.decodeContent(message) });
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
    const result = await this.sessions.registerSession(host, input);
    if (input.adapterProtocol) await this.notifyPresenceReturn(input.sessionId);
    return result;
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
    const result = await this.sessions.heartbeatSession(sessionId, bridgeToken, input);
    if (result) await this.notifyPresenceReturn(sessionId);
    return result;
  }

  async finishSession(sessionId: string, bridgeToken: string, status: 'completed' | 'failed', watchdogFailure?: WatchdogFailure): Promise<Record<string, unknown>> {
    return this.sessions.finishSession(sessionId, bridgeToken, status, watchdogFailure);
  }

  async notifyPresenceReturn(sessionId: string): Promise<void> {
    if (!await this.isEnabled()) return;
    if (await idleSessionPoll(this.db, sessionId, this.env)) return;
    const receipts = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      return queuePresenceNotices(tx, sessionId, {
        env: this.env, keyring: this.keyring,
        server: (db) => this.groups.server(db),
        assertAddressEligibleLocked: (db, address) => this.assertAddressEligibleLocked(db, address),
      });
    });
    for (const receipt of receipts) wsPublisher.publish('agent_messaging.message.changed', receipt);
  }

  private async sendReceipt(result: { created: boolean; message: AgentBusMessage; content: string; sender: AgentBusAddress; target: AgentBusAddress }) {
    const [target] = await this.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, result.target.id)).limit(1);
    const snapshot = await recipientSnapshot(this.db, target ?? result.target, this.env);
    if (result.message.status !== 'queued' && result.message.status !== 'leased') {
      snapshot.delivery_hint = `Stored receipt; message status is ${result.message.status}. Recipient presence is ${snapshot.recipient_presence}. This is not proof of reading.`;
    }
    return { created: result.created, message: messageForParticipant(result.message, result.content, result.sender, result.target), ...snapshot };
  }

  async listAddresses(sessionId: string, bridgeToken: string, filters: AgentDiscoveryFilters = {}): Promise<Record<string, unknown>> {
    return this.sessions.listAddresses(sessionId, bridgeToken, filters);
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

  async listConferences(sessionId: string, bridgeToken: string): Promise<Record<string, unknown>> {
    return this.conference.list(sessionId, bridgeToken);
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

  listAdminGroups() { return this.groups.listAdmin(); }
  getAdminGroup(slug: string) { return this.groups.detailAdmin(slug); }
  createAdminGroup(input: {slug: string; title: string; description?: string | null}) { return this.groups.createAdmin(input); }
  listAdminSubscriptions() { return this.groups.subscriptionsAdmin(); }
  publishAdmin(input: {topic: string; content: string; clientMessageId: string; ttlSeconds?: number | null}) { return this.groups.publishAdmin(input); }
  noticeAddresses(addressIds: string[], content: string, noticeId?: string) { return this.groups.noticeAddresses(addressIds, content, noticeId); }
  listGroups(sessionId: string, token: string) { return this.groups.listForAgent(sessionId, token); }
  createGroup(sessionId: string, token: string, input: {slug: string; title: string; description?: string | null}) { return this.groups.createForAgent(sessionId, token, input); }
  groupMembers(sessionId: string, token: string, slug: string) { return this.groups.detailForAgent(sessionId, token, slug); }
  deleteGroup(sessionId: string, token: string, slug: string) { return this.groups.deleteForAgent(sessionId, token, slug); }
  deleteAdminGroup(slug: string) { return this.groups.deleteAdmin(slug); }
  subscribe(sessionId: string, token: string, topic: string) { return this.groups.subscribe(sessionId, token, topic, true); }
  unsubscribe(sessionId: string, token: string, topic: string) { return this.groups.subscribe(sessionId, token, topic, false); }
  subscriptions(sessionId: string, token: string) { return this.groups.subscriptionsForAgent(sessionId, token); }
  publish(sessionId: string, token: string, input: {topic: string; content: string; clientMessageId: string; ttlSeconds?: number | null}) { return this.groups.publishForAgent(sessionId, token, input); }

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
      queue?: QueuePolicy;
    },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    if (!authenticated.session.agentBusAddressId) {
      throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    }
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    let policy = queuePolicy(input.queue, input.kind === 'request');
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      const sender = await this.requireAddressLocked(tx, authenticated.session.agentBusAddressId!);
      await this.assertSessionAddressLocked(tx, authenticated.session.id, sender);
      if (!input.queue && input.kind !== 'request' && input.conversationId) {
        const [opening] = await tx.select({ deliveryClass: agentBusMessages.deliveryClass }).from(agentBusMessages).where(eq(agentBusMessages.conversationId, input.conversationId)).orderBy(asc(agentBusMessages.sequence)).limit(1);
        if (opening?.deliveryClass === 'coordination') policy = { ...policy, deliveryClass: 'coordination' };
      }
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      // Receipt recovery does not create a delivery. A later recipient disable
      // must not hide a send that already committed under this sender's UUID.
      const target = existing && existing.requestedTarget === input.to.trim().toLowerCase()
        ? await this.requireAddressLocked(tx, existing.targetAddressId)
        : await this.resolveAddressLocked(tx, input.to, true, !!existing);
      if (existing) {
        assertQueuePolicyReplay(existing, policy);
        this.assertMessageIdempotency(existing, target.id, input.conversationId ?? null, null, content, input.kind ?? 'message');
        return { message: existing, sender, target, content, created: false };
      }
      await this.assertAddressEligibleLocked(tx, target);
      await validateRelatedWork(tx, policy.relatedWorkId, target.id);
      if (sender.id === target.id) {
        throw new ValidationError('An agent cannot message itself', { param: 'to' });
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
        awaitingPresence: (await recipientSnapshot(tx, target, this.env)).recipient_presence === 'listening' ? 0 : 1,
        senderName: sender.launchName,
        targetName: target.launchName,
        requestedTarget: input.to.trim().toLowerCase(),
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: input.kind ?? 'message',
        ...policy,
        executionContractVersion: input.kind === 'request' ? 2 : 1,
        workKind: input.kind === 'request' ? 'request' : null,
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
      await coalescePendingRepeats(tx, { messageId, senderAddressId: sender.id, targetAddressId: target.id, policy, now });
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
    return this.sendReceipt(result);
  }

  async replyMessage(
    sessionId: string,
    bridgeToken: string,
    parentMessageId: string,
    input: { content: string; clientMessageId: string; ttlSeconds?: number | null; claimId?: string; taskResult?: TaskResult; queue?: QueuePolicy },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const senderAddressId = authenticated.session.agentBusAddressId;
    if (!senderAddressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    const content = normalizeMessageBody(input.content);
    const clientMessageId = normalizeUuid(input.clientMessageId, 'client_message_id');
    const ttlSeconds = normalizeMessageTtl(input.ttlSeconds);
    let policy = queuePolicy(input.taskResult ? { delivery_class: 'coordination' } : input.queue);
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
      if (!input.queue && parent.deliveryClass === 'coordination') policy = { ...policy, deliveryClass: 'coordination' };
      if (input.taskResult && !parent.workKind) throw new ValidationError('Only work deliveries accept a task result');
      if (input.taskResult && !input.claimId) throw new ValidationError('Task result requires the current claim');
      if (parent.workKind && !input.claimId) {
        throw new ConflictError('Work replies require the accepted delivery claim', 'agent_task_result_not_accepted');
      }
      if (parent.kind === 'presence_notice') throw new ConflictError('Presence notices are informational and cannot be replied to', 'agent_messaging_presence_notice_reply');
      if (!parent.workKind && parent.attempts > 0 && !['completed', 'digested', 'superseded'].includes(parent.status) && !input.claimId) {
        throw new ConflictError('A delivered message requires its current claim; use send for a new follow-up', 'agent_messaging_lease_lost');
      }
      // A progress reply without a result is a status update on still-running
      // work: it keeps the claim held so the real outcome can follow later.
      const progressOnly = !!parent.workKind && !input.taskResult && policy.deliveryClass === 'progress';
      if (parent.workKind && input.claimId) {
        if (progressOnly) await this.assertTaskProgressLocked(tx, parent, input.claimId, `session:${sessionId}`);
        else await this.finishTaskLocked(tx, parent, input.claimId, `session:${sessionId}`, input.taskResult);
      }
      if (input.claimId && !parent.workKind && (
        parent.claimId !== input.claimId || parent.leaseOwner !== `session:${sessionId}` ||
        parent.targetBindingGeneration !== sender.bindingGeneration
      )) throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      if (target.id === SERVER_ADDRESS_ID) {
        throw new ConflictError('Server publications are informational; use the operator portal conversation to respond', 'agent_messaging_server_publication_reply');
      }
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.senderAddressId, sender.id), eq(agentBusMessages.clientMessageId, clientMessageId)))
        .limit(1)
        .for('update');
      const existing = existingRows[0];
      if (existing) {
        assertQueuePolicyReplay(existing, policy);
        this.assertMessageIdempotency(existing, target.id, parent.conversationId, parent.id, content, 'reply');
        return { message: existing, sender, target, content, created: false };
      }
      await this.assertAddressEligibleLocked(tx, target);
      await validateRelatedWork(tx, policy.relatedWorkId, target.id);
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
        awaitingPresence: (await recipientSnapshot(tx, target, this.env)).recipient_presence === 'listening' ? 0 : 1,
        senderName: sender.launchName,
        targetName: target.launchName,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        ...policy,
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
      await coalescePendingRepeats(tx, { messageId, senderAddressId: sender.id, targetAddressId: target.id, policy, now });
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Inserted agent reply could not be read back');
      if (input.claimId && !parent.workKind) await this.finishInformationalReplyLocked(tx, parent, now);
      // An attached conference member reports by replying to its task.
      if (!progressOnly) await this.conference.settleConferenceDispatchLocked(tx, parent.id, now);
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
    return this.sendReceipt(result);
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
    const reports = await this.db.select().from(agentTaskResults).where(eq(agentTaskResults.messageId, message.id)).orderBy(desc(agentTaskResults.createdAt)).limit(100);
    return { message: { ...messageForParticipant(message, this.decodeContent(message), addresses.get(message.senderAddressId)!, addresses.get(message.targetAddressId)!), task_results: reports.map(r => ({ claim_id: r.claimId, created_at: r.createdAt, task_result: taskResultSchema.parse(JSON.parse(decrypt(r.bodyEnc, this.keyring))) })) } };
  }

  async getDigest(sessionId: string, token: string, digestId: string, after = 0, limit = 20): Promise<Record<string, unknown>> {
    const auth = await this.authenticateBridge(sessionId, token);
    const id = normalizeUuid(digestId, 'digest_id');
    const root = await this.getMessage(sessionId, token, id);
    const message = root.message as Record<string, unknown>;
    if (message.kind !== 'digest') throw new NotFoundError('Digest not found', 'agent_messaging_message_not_found');
    const members = await this.db.select().from(agentBusMessages).where(and(or(eq(agentBusMessages.digestId, id), sql`${agentBusMessages.supersededById} IN (SELECT member.id FROM agent_bus_messages member WHERE member.digest_id = ${id})`), eq(agentBusMessages.targetAddressId, auth.session.agentBusAddressId!), gt(agentBusMessages.dispatchOrder, after))).orderBy(asc(agentBusMessages.dispatchOrder)).limit(limit + 1);
    const page = members.slice(0, limit);
    const addresses = await this.addressMap(page.flatMap(m => [m.senderAddressId, m.targetAddressId]));
    return { digest_id: id, messages: page.map(m => messageForParticipant(m, this.decodeContent(m), addresses.get(m.senderAddressId)!, addresses.get(m.targetAddressId)!)), next_after: members.length > limit ? page[page.length - 1]!.dispatchOrder : null };
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

  async claimForSession(sessionId: string, bridgeToken: string, claimId: string, receiverGeneration?: string, informationalOnly = false): Promise<MessageDelivery | null> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    const addressId = authenticated.session.agentBusAddressId;
    if (!addressId) throw new ConflictError('Agent session has no messaging address', 'agent_messaging_address_missing');
    if (!authenticated.session.receiveHeartbeatAt) {
      throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
    }
    normalizeUuid(claimId, 'claim_id');
    if (await idleSessionPoll(this.db, sessionId, this.env, { bridgeToken, receiverGeneration })) return null;
    return await this.claimDelivery([addressId], `session:${sessionId}`, claimId, null, false, receiverGeneration, informationalOnly, smartQueueAllowed(this.env, authenticated.host.id, authenticated.session.receiver), peerBatchAllowed(this.env, authenticated.session.receiver));
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
      // The reserved Server publisher deliberately has no host row.
      .leftJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(
        and(
          eq(agentBusMessages.targetAddressId, addressId),
          or(
            and(eq(agentBusMessages.status, 'queued'), gt(agentBusMessages.expiresAt, now)),
            and(eq(agentBusMessages.status, 'expired'), gt(agentBusMessages.expiredAt, missedAfter)),
          ),
        ),
      )
      // A page of historical missed calls must not hide a current waiting one.
      .orderBy(desc(sql`${agentBusMessages.status} = 'queued'`), asc(agentBusMessages.dispatchOrder))
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
    if (input.capabilities?.host_daemon === true) {
      const [daemon] = await this.db.select().from(hostDaemons).where(eq(hostDaemons.hostId, host.id));
      if ((!daemon || !daemonAccepting(daemon.settings)) || username !== daemon.settings.username + ':daemon') throw new ForbiddenError('Daemon relay is not enabled');
    } else {
      await this.assertPersistentHost(host.id, username);
    }
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
    const relay = await this.authenticateRelay(relayId, rawToken, true);
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
    const targets = await this.relayClaimTargets(relayId, rawToken);
    if (!targets) return null;
    return await this.claimDelivery(targets.ids, `relay:${targets.relay.id}:${targets.relay.generation}`, claimId, targets.relay.generation, true);
  }

  /**
   * True exactly when `claimForRelay` would return null before claimDelivery. Same admission and the same errors in
   * the same order; it claims nothing, so concurrent waiters of one relay credential may share a true answer.
   */
  async relayIdle(relayId: string, rawToken: string): Promise<boolean> {
    return (await this.relayClaimTargets(relayId, rawToken)) === null;
  }

  private async relayClaimTargets(relayId: string, rawToken: string): Promise<{ relay: AgentBusRelay; ids: string[] } | null> {
    const relay = await this.authenticateRelay(relayId, rawToken, true);
    const daemonRelay = jsonRecord(relay.capabilities)?.host_daemon === true;
    const targetUsername = daemonRelay ? relay.username.replace(/:daemon$/, '') : relay.username;
    const remoteSessions = await this.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, relay.hostId));
    const remoteIds = new Set(remoteSessions.map(s => s.addressId));
    const rows = await this.db
      .select({ id: agentBusAddresses.id, engine: agentBusAddresses.engine, hostEngines: hosts.engines })
      .from(agentBusAddresses)
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .where(and(
        eq(agentBusAddresses.hostId, relay.hostId),
        eq(agentBusAddresses.username, targetUsername),
        eq(agentBusAddresses.enabled, 1),
        isNull(agentBusAddresses.archivedAt),
        messagingHostEligibleSql(),
        isNull(agentBusAddresses.currentSessionId),
      ));
    if (rows.length === 0) return null;
    const fleet = await readFleetEngineState(this.db);
    const eligible = rows.filter((row) => activeHostEngines(row.hostEngines, fleet).includes(row.engine as Engine) && (daemonRelay ? remoteSessions.some(s => s.addressId === row.id && ['idle', 'waiting'].includes(s.status)) : !remoteIds.has(row.id)));
    if (eligible.length === 0) return null;
    const targetIds = eligible.map((row) => row.id);
    // Almost every relay poll finds nothing (production: ~18K messages ever against ~100M polls), yet claimDelivery
    // opens with the exclusive enable-flag row lock. Polling relays therefore queued behind each other and behind real
    // writers, pinning API pool connections while they waited. A poll that changes nothing needs no fence: with no
    // pending row it is indistinguishable from one that ran just before any concurrent send or disable.
    if (!(await this.hasPendingRelayWork(targetIds))) return null;
    return { relay, ids: targetIds };
  }

  /**
   * Cover every row the locked relay path can change: due/expired queued mail,
   * every lease (including replay), and notice/publication/digest cleanup.
   * Ordinary future retries and accepted work cannot change on this path.
   */
  private async hasPendingRelayWork(targetAddressIds: string[]): Promise<boolean> {
    const now = nowIso();
    const rows = await this.db
      .select({ id: agentBusMessages.id })
      .from(agentBusMessages)
      .where(and(inArray(agentBusMessages.targetAddressId, targetAddressIds), or(
        eq(agentBusMessages.status, 'leased'),
        relayDigestRecoveryPending(this.db),
        and(eq(agentBusMessages.status, 'queued'), or(
          lte(agentBusMessages.nextAttemptAt, now),
          lte(agentBusMessages.expiresAt, now),
          // Routine retirement can act before a queued notice's retry time.
          inArray(agentBusMessages.kind, ['presence_notice', 'publication', 'digest']),
        )),
        and(eq(agentBusMessages.kind, 'presence_notice'), inArray(agentBusMessages.status, ['accepted', 'batched'])),
      )))
      .limit(1);
    return rows.length > 0;
  }

  private async assertTaskLeaseLocked(tx: Parameters<Parameters<Database['transaction']>[0]>[0], message: AgentBusMessage, claimId: string, leaseOwner: string) {
    if (message.claimId !== claimId || message.leaseOwner !== leaseOwner) throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
    const target = await this.requireAddressLocked(tx, message.targetAddressId);
    if (target.bindingGeneration !== message.targetBindingGeneration) throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
    if (message.status === 'accepted' && (!message.leaseUntil || message.leaseUntil <= nowIso())) throw new ConflictError('Delivery lease expired', 'agent_messaging_lease_lost');
  }

  /** A progress reply leaves accepted work held: no result, no completion. */
  private async assertTaskProgressLocked(tx: Parameters<Parameters<Database['transaction']>[0]>[0], message: AgentBusMessage, claimId: string, leaseOwner: string) {
    await this.assertTaskLeaseLocked(tx, message, claimId, leaseOwner);
    if (message.status !== 'accepted') throw new ConflictError('Progress replies require accepted, unfinished work', 'agent_task_result_not_accepted');
  }

  private async finishTaskLocked(tx: Parameters<Parameters<Database['transaction']>[0]>[0], message: AgentBusMessage, claimId: string, leaseOwner: string, result?: TaskResult) {
    await this.assertTaskLeaseLocked(tx, message, claimId, leaseOwner);
    const report = await storeTaskResult(tx, message, result ?? unknownTaskResult, this.keyring, nowIso());
    // Receipt replay verifies the immutable result without changing when work ended.
    if (message.status === 'completed') return;
    await tx.update(agentBusMessages).set({ status: 'completed', taskResultStatus: report.status, completedAt: nowIso(), leaseUntil: null, updatedAt: nowIso() }).where(eq(agentBusMessages.id, message.id));
  }

  /** A claimed informational reply is a receipt too: store it and finish atomically. */
  private async finishInformationalReplyLocked(tx: AgentMessagingDb, message: AgentBusMessage, now: string) {
    if (!['leased', 'accepted'].includes(message.status) || !message.leaseUntil || message.leaseUntil <= now) {
      throw new ConflictError('Delivery lease expired or ended', 'agent_messaging_lease_lost');
    }
    if (message.status === 'leased' && message.expiresAt <= now) {
      throw new ConflictError('Message expired before acceptance', 'agent_messaging_message_expired');
    }
    await tx.update(agentBusMessages).set({
      status: 'completed', acceptedAt: message.acceptedAt ?? now, completedAt: now, leaseUntil: null, updatedAt: now,
    }).where(eq(agentBusMessages.id, message.id));
  }

  async approveMessageFreshStart(messageId: string, version: number, reason: string, actor: string): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const why = normalizeMessageBody(reason);
    if (Buffer.byteLength(why, 'utf8') > 500) throw new ValidationError('Reason exceeds 500 bytes');
    const result = await this.db.transaction(async tx => {
      await this.requireEnabledLocked(tx);
      const [message] = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      if (!message) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      const target = await this.requireAddressLocked(tx, message.targetAddressId);
      return { grant: await approveFreshStart(tx, message, target, version, why, actor, nowIso()), hostId: target.hostId, engine: target.engine };
    });
    await this.recordRuntime('agent_message.fresh_start_approved', result.hostId, result.engine, { message_id: id, actor, reason: why });
    wsPublisher.publish('agent_messaging.message.changed', { message_id: id });
    return { grant: result.grant };
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
    input: { claimId: string; outcome: AgentMessagingOutcome; taskResult?: TaskResult; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
  ): Promise<Record<string, unknown>> {
    const authenticated = await this.authenticateBridge(sessionId, bridgeToken);
    return await this.acknowledgeDelivery(messageId, input, `session:${sessionId}`, null, authenticated.session.id);
  }

  async acknowledgeRelayDelivery(
    relayId: string,
    rawToken: string,
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; taskResult?: TaskResult; deliverySessionId?: string | null; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
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
      taskResult?: TaskResult;
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
        (parent.status !== 'leased' && parent.status !== 'accepted' && parent.status !== 'completed')
      ) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      if (parent.workKind) await this.finishTaskLocked(tx, parent, claimId, `relay:${relay.id}:${relay.generation}`, input.taskResult);
      const sender = await this.requireAddressLocked(tx, parent.targetAddressId);
      if (sender.bindingGeneration !== parent.targetBindingGeneration) throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      const relayUsername = jsonRecord(relay.capabilities)?.host_daemon === true ? `${sender.username}:daemon` : sender.username;
      if (sender.hostId !== relay.hostId || relayUsername !== relay.username) {
        throw new ForbiddenError('Relay does not own this delivery address', 'agent_messaging_relay_target_mismatch');
      }
      const target = await this.requireAddressLocked(tx, parent.senderAddressId);
      if (target.id === SERVER_ADDRESS_ID) {
        throw new ConflictError('Server publications are informational; use the operator portal conversation to respond', 'agent_messaging_server_publication_reply');
      }
      const existingRows = await tx
        .select()
        .from(agentBusMessages)
        .where(and(eq(agentBusMessages.replyToMessageId, parent.id), eq(agentBusMessages.senderAddressId, sender.id)))
        .limit(1)
        .for('update');
      if (existingRows[0]) {
        this.assertMessageIdempotency(existingRows[0], target.id, parent.conversationId, parent.id, content, 'reply');
        return { message: existingRows[0], sender, target, created: false };
      }
      await this.assertAddressEligibleLocked(tx, target);
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
        senderName: sender.launchName,
        targetName: target.launchName,
        targetAddressId: target.id,
        sourceEngine: sender.engine,
        targetEngine: target.engine,
        kind: 'reply',
        deliveryClass: parent.workKind || parent.deliveryClass === 'coordination' ? 'coordination' : 'information',
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
      if (!parent.workKind) await this.finishInformationalReplyLocked(tx, parent, now);
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
        .set({ deliverySessionId: deliverySessionId ?? parent.deliverySessionId, deliveryUpstreamSessionId: upstreamSessionId ?? parent.deliveryUpstreamSessionId, updatedAt: now })
        .where(eq(agentBusMessages.id, parent.id));
      if (upstreamSessionId) {
        await assertHousekeepingAvailable(tx, sender.hostId, sender.engine);
        await tx.update(agentBusAddresses).set({ lastUpstreamSessionId: upstreamSessionId, continuity: 'native', readiness: sender.currentSessionId ? sender.readiness : 'resumable', lastSeenAt: now, updatedAt: now }).where(eq(agentBusAddresses.id, sender.id));
      }
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

  listAdminConferences(options: { status?: string; limit?: number } = {}) { return this.conferenceAdmin.list(options); }
  getAdminConference(id: string) { return this.conferenceAdmin.detail(id); }
  listAdminConferenceMessages(id: string, options: ConferencePageOptions = {}) { return this.conferenceAdmin.messages(id, options); }
  revealAdminConferenceMessages(id: string, ids: string[]) { return this.conferenceAdmin.messages(id, { limit: 100 }, ids); }

  async listAdminAddresses(): Promise<Record<string, unknown>> {
    return this.admin.listAdminAddresses();
  }

  async translateForHost(host: Host, value: string): Promise<Record<string, unknown>> {
    this.assertEligibleHost(host);
    if (!activeHostEngines(host.engines, await readFleetEngineState(this.db)).length)
      throw new ForbiddenError('Host engines are suspended', 'engine_disabled');
    return await this.translate(value);
  }

  /** Read-only host-scope inventory for an operator shell (host API key). */
  async listAddressesForHost(host: Host, filters: HostInventoryFilters = {}): Promise<Record<string, unknown>> {
    this.assertEligibleHost(host);
    return await listHostInventory(
      { db: this.db, presenceFreshSeconds: this.env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS, isEnabled: () => this.isEnabled() },
      host,
      filters,
    );
  }

  async translate(value: string, sessionId?: string, bridgeToken?: string): Promise<Record<string, unknown>> {
    if (sessionId && bridgeToken) await this.authenticateBridge(sessionId, bridgeToken);
    return await this.db.transaction(async tx => {
      await this.requireEnabledLocked(tx);
      const result = await translateAgent(tx, value);
      const address = await this.requireAddressLocked(tx, String(result.uuid));
      await this.assertAddressEligibleLocked(tx, address);
      return result;
    });
  }

  async self(sessionId: string, bridgeToken: string): Promise<Record<string, unknown>> {
    await this.authenticateBridge(sessionId, bridgeToken);
    return await this.db.transaction(async tx => {
      await this.requireEnabledLocked(tx);
      const session = await this.lockSessionHostFirst(tx, sessionId);
      if (!session || session.endedAt || session.bridgeExpiresAt <= nowIso() || !session.agentBusAddressId)
        throw new ConflictError('Launch identity is unavailable', 'agent_identity_unavailable');
      const address = await this.requireAddressLocked(tx, session.agentBusAddressId);
      await this.assertAddressEligibleLocked(tx, address);
      if (address.currentSessionId !== session.id || address.bindingGeneration !== session.bindingGeneration || !session.launchName || address.launchName !== session.launchName)
        throw new ConflictError('Launch identity binding changed', 'agent_identity_unavailable');
      const identity = await translateAgent(tx, session.launchName, true);
      if (identity.uuid !== address.id || identity.session_id !== session.id || identity.status !== 'active')
        throw new ConflictError('Launch name lease changed', 'agent_identity_unavailable');
      const leases = await tx.selectDistinct({ name: agentNameLeases.name }).from(agentNameLeases).where(or(eq(agentNameLeases.addressId, address.id), eq(agentNameLeases.sessionId, session.id)));
      const [named] = await tx.select().from(agentEvents).where(and(eq(agentEvents.sessionId, session.id), eq(agentEvents.eventType, 'session_named'))).orderBy(desc(agentEvents.id)).limit(1);
      const naming = named ? JSON.parse(decrypt(named.payloadEnc, this.keyring)) as Record<string, unknown> : null;
      const taskTitle = naming?.native_session_id === session.upstreamSessionId && typeof naming?.name === 'string' ? naming.name : null;
      return { identity_version: 1, name: session.launchName, uuid: address.id, address: `agent:${address.id}`,
        session_id: session.id, native_session_id: session.upstreamSessionId, engine: session.engine,
        binding_generation: session.bindingGeneration, previous_names: [...new Set(leases.map(row => row.name))], task_title: taskTitle,
        role: (await activeRolesForAddresses(tx, [address.id])).get(address.id) ?? null,
        role_labels: await roleLabelsForAddress(tx, address.id) };
    });
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

  async listAdminMessages(options: { conversationId?: string; messageId?: string; status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.admin.listAdminMessages(options);
  }

  async revealMessage(messageId: string): Promise<Record<string, unknown>> {
    const revealed = await this.admin.revealMessage(messageId);
    const results = await this.db.select().from(agentTaskResults).where(eq(agentTaskResults.messageId, normalizeUuid(messageId, 'message_id'))).orderBy(asc(agentTaskResults.createdAt));
    return { ...revealed, task_results: results.map(r => ({ claim_id: r.claimId, created_at: r.createdAt, task_result: taskResultSchema.parse(JSON.parse(decrypt(r.bodyEnc, this.keyring))) })) };
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
      await expireRebootHandoffs(tx, now);
      await discardPresenceNotices(tx, now);
      const releasedBindings = await reapExpiredAgentMessagingBindingsLocked(tx, now);
      // Expired PINs are also swept at mint and redeem time; doing it here as
      // well means a PIN nobody ever dials does not squat its slot in the unique
      // index until the next conference operation.
      await this.conference.sweepPinsLocked(tx, now);
      const expiring = await tx.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, ['queued', 'leased', 'batched']), lte(agentBusMessages.expiresAt, now)));
      const retryable = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      const exhausted = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      const uncertain = await tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), or(lte(agentBusMessages.leaseUntil, now), and(isNull(agentBusMessages.leaseUntil), lte(agentBusMessages.updatedAt, isoOffsetSeconds(-86400))))));
      await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(inArray(agentBusMessages.status, ['queued', 'leased', 'batched']), lte(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'queued', nextAttemptAt: now, leaseOwner: null, leaseUntil: null, claimId: null, relayGeneration: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), lte(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1), gt(agentBusMessages.expiresAt, now)));
      await tx.update(agentBusMessages).set({ status: 'dead', deadAt: now, lastErrorCode: 'delivery_attempts_exhausted', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'leased'), lte(agentBusMessages.leaseUntil, now), gt(agentBusMessages.attempts, AGENT_MESSAGING_MAX_DELIVERY_ATTEMPTS - 1)));
      await tx.update(agentBusMessages).set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'accepted_lease_lost', leaseOwner: null, leaseUntil: null, updatedAt: now }).where(and(eq(agentBusMessages.status, 'accepted'), or(lte(agentBusMessages.leaseUntil, now), and(isNull(agentBusMessages.leaseUntil), lte(agentBusMessages.updatedAt, isoOffsetSeconds(-86400))))));
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
    receiverGeneration?: string,
    informationalOnly = false,
    smartQueue = false,
    peerBatch = false,
  ): Promise<MessageDelivery | null> {
    const claimId = normalizeUuid(rawClaimId, 'claim_id');
    const now = nowIso();
    const leaseUntil = isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS);
    const receiveFreshAfter = isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const claimingSessionId = relayGeneration == null ? sessionIdFromLeaseOwner(leaseOwner) : null;
    const result = await this.db.transaction(async (tx) => {
      await this.requireEnabledLocked(tx);
      if (relayGeneration != null) {
        const relayId = relayIdFromLeaseOwner(leaseOwner);
        if (!relayId) throw new ConflictError('Relay lease owner is invalid', 'agent_messaging_lease_lost');
        await this.requireRelayGenerationLocked(tx, relayId, relayGeneration);
      } else {
        const sessionId = sessionIdFromLeaseOwner(leaseOwner);
        if (!sessionId) throw new ConflictError('Session lease owner is invalid', 'agent_messaging_lease_lost');
        const session = await this.lockSessionHostFirst(tx, sessionId);
        if (!session?.agentBusAddressId || !targetAddressIds.includes(session.agentBusAddressId)) {
          throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
        }
        if (receiverState(session.receiver) &&
          (receiverState(session.receiver)?.generation !== receiverGeneration || !receiverReady(session.receiver, 'peer'))) {
          throw new ConflictError('Receiver generation is unavailable', 'receiver_generation_changed');
        }
        const target = await this.requireAddressLocked(tx, session.agentBusAddressId);
        await this.assertSessionAddressLocked(tx, sessionId, target);
        if (!session.receiveHeartbeatAt || session.receiveHeartbeatAt <= receiveFreshAfter) {
          throw new ConflictError('Agent session is not receive-capable', 'agent_messaging_adapter_unavailable');
        }
      }
      await discardPresenceNotices(tx, now, targetAddressIds);
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
        if (informationalOnly && (replayRows[0].workKind || ['request', 'task', 'schedule'].includes(replayRows[0].kind))) return null;
        const target = await this.requireAddressLocked(tx, replayRows[0].targetAddressId);
        const sender = await this.requireAddressLocked(tx, replayRows[0].senderAddressId);
        return { message: replayRows[0], sender, target };
      }

      if (relayGeneration == null) {
        const target = await this.requireAddressLocked(tx, targetAddressIds[0]!);
        await restoreUnpresentedDigests(tx, target.id, !smartQueue, { allowed: peerBatch, keyring: this.keyring });
      } else {
        // A relay cannot present peer/smart digests. A session may have left an
        // unpresented batch at FIFO head when it detached. Restore only after
        // checking the current binding under the same bus/address locks.
        const recoveries = await relayDigestRecoveryTargets(tx, targetAddressIds);
        for (const { id } of recoveries) {
          const target = await this.requireAddressLocked(tx, id);
          if (!target.currentSessionId) await restoreRelayDigests(tx, id);
        }
      }
      const routineScan = await retireRoutineNotices(tx, this.keyring, targetAddressIds, now);
      if (relayGeneration == null && routineScan.complete) {
        const target = await this.requireAddressLocked(tx, targetAddressIds[0]!);
        if (peerBatch) await preparePeerBatch(tx, target, { keyring: this.keyring, server: db => this.groups.server(db) });
        else if (smartQueue) await prepareSmartDigest(tx, target, { keyring: this.keyring, server: db => this.groups.server(db) });
      }
      const candidateOrder = presentationOrder(sql`${agentBusMessages.id}`, sql`${agentBusMessages.kind}`, sql`${agentBusMessages.dispatchOrder}`, sql`${agentBusMessages.deliveryClass}`);
      const earlierOrder = presentationOrder(sql`earlier.id`, sql`earlier.kind`, sql`earlier.dispatch_order`, sql`earlier.delivery_class`);
      const candidates = await tx
        .select()
        .from(agentBusMessages)
        .where(and(
          inArray(agentBusMessages.targetAddressId, targetAddressIds),
          eq(agentBusMessages.status, 'queued'),
          sql`NOT EXISTS (SELECT 1 FROM agent_reboot_handoffs rh WHERE rh.address_id = ${agentBusMessages.targetAddressId} COLLATE utf8mb4_unicode_ci AND rh.status = 'armed')`,
          // Retry backoff fences the delivery path that failed, not the message.
          // A live session claiming a row that some other path retried (the relay's
          // native_session_busy, or an earlier session) must not inherit that
          // backoff: on 2026-10-14 a returning Claude session sat "ready" for over
          // four minutes behind a message the relay had backed off by 900s, with
          // every later message queued FIFO behind it while the hook kept ringing.
          // The session's own retries keep their backoff.
          claimingSessionId
            ? or(
              lte(agentBusMessages.nextAttemptAt, now),
              isNull(agentBusMessages.deliverySessionId),
              ne(agentBusMessages.deliverySessionId, claimingSessionId),
            )
            : lte(agentBusMessages.nextAttemptAt, now),
          gt(agentBusMessages.expiresAt, now),
          smartQueue ? sql`NOT EXISTS (
            SELECT 1 FROM agent_bus_messages AS earlier
             WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
               AND earlier.status IN ('queued','leased','accepted','reboot_hold')
               AND earlier.id <> ${agentBusMessages.id}
               AND (
                 ((${agentBusMessages.workKind} IS NOT NULL OR ${agentBusMessages.kind} IN ('request','task','schedule'))
                   AND (earlier.status IN ('leased','accepted','reboot_hold') OR
                     ((earlier.work_kind IS NOT NULL OR earlier.kind IN ('request','task','schedule')) AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder})))
                 OR ((${agentBusMessages.workKind} IS NULL AND ${agentBusMessages.kind} NOT IN ('request','task','schedule'))
                   AND earlier.work_kind IS NULL AND earlier.kind NOT IN ('request','task','schedule')
                   AND (earlier.status IN ('leased','accepted','reboot_hold') OR
                     (${agentBusMessages.deliveryClass} = 'coordination' AND earlier.delivery_class = 'coordination' AND ${earlierOrder} < ${candidateOrder}) OR
                     (${agentBusMessages.deliveryClass} <> 'coordination' AND (earlier.delivery_class = 'coordination' OR
                       (${agentBusMessages.kind} = 'digest' AND earlier.kind = 'digest' AND ${earlierOrder} < ${candidateOrder}) OR
                       (${agentBusMessages.kind} <> 'digest' AND (earlier.kind = 'digest' OR ${earlierOrder} < ${candidateOrder}))))))
               )
          )` : and(
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS earlier
             WHERE earlier.target_address_id = ${agentBusMessages.targetAddressId}
               AND earlier.status IN ('queued', 'leased', 'accepted', 'reboot_hold')
               AND earlier.dispatch_order < ${agentBusMessages.dispatchOrder}
          )`,
          sql`NOT EXISTS (
            SELECT 1
              FROM agent_bus_messages AS in_flight
             WHERE in_flight.target_address_id = ${agentBusMessages.targetAddressId}
               AND in_flight.status IN ('leased', 'accepted', 'reboot_hold')
               AND in_flight.id <> ${agentBusMessages.id}
          )`,
          ),
          ...(!smartQueue ? [sql`${agentBusMessages.kind} <> 'digest'`] : []),
          ...(informationalOnly ? [sql`${agentBusMessages.workKind} IS NULL AND ${agentBusMessages.kind} NOT IN ('request','task','schedule')`] : []),
        ))
        .orderBy(smartQueue ? sql`CASE WHEN ${agentBusMessages.deliveryClass} = 'coordination' THEN 0 WHEN ${agentBusMessages.workKind} IS NOT NULL THEN 1 WHEN ${agentBusMessages.kind} = 'digest' THEN 2 ELSE 3 END` : asc(agentBusMessages.dispatchOrder), smartQueue ? candidateOrder : asc(agentBusMessages.dispatchOrder))
        .limit(64)
        .for('update');
      for (const candidate of candidates) {
        if (await retireRoutineNotice(tx, candidate, this.keyring, now)) continue;
        // A one-shot CLI reader cannot keep work alive or report its result.
        // Leave the FIFO head untouched for a persistent execution adapter.
        if (informationalOnly && (candidate.workKind || ['request', 'task', 'schedule'].includes(candidate.kind))) continue;
        if (candidate.kind === 'presence_notice' && (skipReceiveCapable || candidate.targetSessionId !== sessionIdFromLeaseOwner(leaseOwner))) continue;
        const target = await this.requireAddressLocked(tx, candidate.targetAddressId);
        await this.assertAddressEligibleLocked(tx, target);
        // A relay must never write to a native upstream session while its
        // interactive wrapper is still attached. Receive-capable sessions
        // claim live; non-channel sessions leave work queued until they exit.
        if (skipReceiveCapable && target.currentSessionId) continue;
        // Informational mail is not permission to create a replacement agent.
        // Older workers otherwise start a fresh native session for reset targets.
        if (skipReceiveCapable && !candidate.workKind && (!target.lastUpstreamSessionId || target.continuity !== 'native')) {
          await tx.update(agentBusMessages).set({
            status: 'dead', deadAt: now, lastErrorCode: 'native_transcript_missing', updatedAt: now,
          }).where(eq(agentBusMessages.id, candidate.id));
          continue;
        }
        if (!skipReceiveCapable && await freshStartAllowed(tx, candidate, target)) {
          await tx.update(agentBusMessages).set({ lastErrorCode: 'fresh_start_waiting_idle', updatedAt: now }).where(eq(agentBusMessages.id, candidate.id));
          continue;
        }
        if (candidate.kind === 'schedule') {
          const [run] = await tx.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.messageId, candidate.id)).limit(1);
          const [schedule] = run ? await tx.select().from(agentSchedules).where(eq(agentSchedules.id, run.scheduleId)).limit(1) : [];
          if (!run || !schedule?.enabled || schedule.deletedAt || (skipReceiveCapable && !run.persistent)) continue;
          const [watchdog] = await tx.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId,run.scheduleId));
          if (watchdog && (!['watching','recovering','capacity_wait'].includes(watchdog.status) || watchdog.deadlineAt <= now || target.lastUpstreamSessionId !== watchdog.nativeSessionId || target.continuity !== 'native')) continue;
          const quota = watchdog?.quotaAccountId ? { account_id: watchdog.quotaAccountId, window: watchdog.quotaWindow } : run.quotaRecovery;
          if (quota && isEngine(target.engine) && !(await quotaRecoveryAllowed(tx, target.engine, quota.account_id, quota.window))) continue;
          if (watchdog) {
            const [relay] = relayGeneration != null ? await tx.select().from(agentBusRelays).where(eq(agentBusRelays.id, relayIdFromLeaseOwner(leaseOwner)!)).limit(1) : [];
            const capabilities = jsonRecord(relayGeneration != null ? relay?.capabilities ?? null : target.adapterCapabilities) ?? {};
            if (capabilities.watchdog_protocol_version !== 1) {
              await tx.update(agentBusMessages).set({ lastErrorCode: 'adapter_upgrade_required', updatedAt: now }).where(eq(agentBusMessages.id, candidate.id));
              continue;
            }
          }
        }
        if (candidate.executionContractVersion >= 2) {
          let capabilities: Record<string, unknown> = jsonRecord(target.adapterCapabilities) ?? {};
          if (relayGeneration != null) {
            const [relay] = await tx.select().from(agentBusRelays).where(eq(agentBusRelays.id, relayIdFromLeaseOwner(leaseOwner)!)).limit(1);
            capabilities = jsonRecord(relay?.capabilities ?? null) ?? {};
          }
          if (capabilities.execution_contract_version !== 2) {
            await tx.update(agentBusMessages).set({ lastErrorCode: 'adapter_upgrade_required', updatedAt: now }).where(eq(agentBusMessages.id, candidate.id));
            continue;
          }
        }
        const [remoteHost] = await tx.select({ hostId: hostDaemonSessions.hostId }).from(hostDaemonSessions).where(eq(hostDaemonSessions.addressId, target.id));
        if (remoteHost && skipReceiveCapable) await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, remoteHost.hostId)).for('update');
        const [remote] = await tx.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.addressId, target.id)).for('update');
        if (remote && skipReceiveCapable) {
          const [daemon] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, remote.hostId)).for('update');
          const working = await tx.select().from(hostDaemonSessions).where(and(eq(hostDaemonSessions.hostId, remote.hostId), inArray(hostDaemonSessions.status, ['running', 'stopping'])));
          if ((!daemon || !daemonAccepting(daemon.settings)) || !['idle', 'waiting'].includes(remote.status) || working.length >= daemon.settings.max_parallel) continue;
          if (Date.now() - Date.parse(candidate.createdAt) >= 600_000) {
            await tx.update(agentBusMessages).set({ status: 'expired', expiredAt: now, updatedAt: now }).where(eq(agentBusMessages.id, candidate.id));
            continue;
          }
          await tx.update(hostDaemonSessions).set({ status: 'running', activeMessageId: candidate.id, lastActivityAt: now }).where(eq(hostDaemonSessions.id, remote.id));
        }
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
    const delivery = deliveryView(result.message, this.decodeContent(result.message), result.sender, result.target);
    const [remote] = await this.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.addressId, result.target.id));
    if (remote) delivery.target.daemon_session_id = remote.id;
    // A pinned model (Fleet Advisor) must survive peer-delivered turns too.
    if (remote?.model) delivery.target.daemon_model = remote.model;
    if (await freshStartAllowed(this.db, result.message, result.target)) delivery.target.fresh_start_approved = true;
    if (result.message.kind === 'schedule') {
      const [run] = await this.db.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.messageId, result.message.id)).limit(1);
      if (run) {
        delivery.target = { ...delivery.target, schedule_id: run.scheduleId, schedule_run_id: run.id, schedule_persistent: run.persistent === 1, progress_timeout_seconds: run.progressTimeoutSeconds };
        const [watchdog] = await this.db.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId, run.scheduleId));
        if (watchdog) delivery.target = { ...delivery.target, watchdog_id: watchdog.id, watchdog_deadline_at: watchdog.deadlineAt, watchdog_native_session_id: watchdog.nativeSessionId };
      }
    }
    return delivery;
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
      if (!message || (message.status !== 'leased' && message.status !== 'accepted' && message.status !== 'reboot_hold') || message.leaseOwner !== leaseOwner || message.claimId !== claimId) {
        throw new ConflictError('Message lease is no longer owned by this delivery', 'agent_messaging_lease_lost');
      }
      if (message.status === 'reboot_hold') return message;
      const boundTarget = await this.requireAddressLocked(tx, message.targetAddressId);
      if (message.targetBindingGeneration !== boundTarget.bindingGeneration || !message.leaseUntil || message.leaseUntil <= now) throw new ConflictError('Delivery lease or target binding changed', 'agent_messaging_lease_lost');
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
        return null;
      }
      await tx.update(agentBusMessages).set({ leaseUntil, updatedAt: now }).where(eq(agentBusMessages.id, id));
      return message;
    });
    // Throw after commit: throwing inside the transaction undoes expiry cleanup.
    if (!result) throw new ConflictError('Message expired', 'agent_messaging_message_expired');
    return { message_id: result.id, lease_until: leaseUntil };
  }

  private async acknowledgeDelivery(
    messageId: string,
    input: { claimId: string; outcome: AgentMessagingOutcome; taskResult?: TaskResult; upstreamSessionId?: string | null; errorCode?: string | null; error?: string | null },
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
      if (message.status === 'reboot_hold') return message;
      const currentTarget = await this.requireAddressLocked(tx, message.targetAddressId);
      if (message.kind === 'presence_notice') {
        const [noticeSession] = message.targetSessionId ? await tx.select().from(agentSessions).where(eq(agentSessions.id, message.targetSessionId)).limit(1) : [];
        if (relayGeneration != null || currentTarget.currentSessionId !== message.targetSessionId || noticeSession?.endedAt || !noticeSession) {
          throw new ConflictError('Presence notice belongs to an ended session', 'agent_messaging_lease_lost');
        }
      }
      if (currentTarget.bindingGeneration !== message.targetBindingGeneration) {
        throw new ConflictError('Agent address binding changed', 'agent_messaging_binding_stale');
      }
      if (input.taskResult && !message.workKind) throw new ValidationError('Only work deliveries accept a task result');
      if (input.taskResult && input.outcome !== 'completed') throw new ValidationError('Task result requires completed transport');
      if (TERMINAL_MESSAGE_STATUSES.includes(message.status as (typeof TERMINAL_MESSAGE_STATUSES)[number])) {
        if (input.taskResult) await storeTaskResult(tx, message, input.taskResult, this.keyring, now);
        return message;
      }
      if (['accepted','completed'].includes(input.outcome) && (!message.leaseUntil || message.leaseUntil <= now)) throw new ConflictError('Delivery lease expired', 'agent_messaging_lease_lost');
      if (['accepted', 'completed'].includes(input.outcome) && message.status === 'leased' && message.expiresAt <= now) {
        throw new ConflictError('Message expired before acceptance', 'agent_messaging_message_expired');
      }
      if (input.outcome === 'accepted' && message.status === 'accepted') return message;
      if (input.outcome === 'accepted' && message.kind === 'schedule') {
        const [run] = await tx.select().from(agentScheduleRuns).where(eq(agentScheduleRuns.messageId, message.id)).limit(1);
        const [watchdog] = run ? await tx.select().from(agentWatchdogs).where(eq(agentWatchdogs.scheduleId, run.scheduleId)) : [];
        if (watchdog && (!['watching','recovering','capacity_wait'].includes(watchdog.status) || watchdog.deadlineAt <= now || currentTarget.lastUpstreamSessionId !== watchdog.nativeSessionId || (upstreamSessionId && upstreamSessionId !== watchdog.nativeSessionId)))
          throw new ConflictError('Watchdog recovery expired or native binding changed', 'watchdog_recovery_unavailable');
        const quota = watchdog?.quotaAccountId ? { account_id: watchdog.quotaAccountId, window: watchdog.quotaWindow } : run?.quotaRecovery;
        if (quota && isEngine(currentTarget.engine) && !(await quotaRecoveryAllowed(tx, currentTarget.engine, quota.account_id, quota.window)))
          throw new ConflictError('Quota recovery policy changed', 'quota_recovery_disabled');
      }
      if (input.outcome === 'accepted' && await freshStartAllowed(tx, message, currentTarget)) {
        await tx.update(agentFreshStartGrants).set({ consumedAt: now, consumedClaimId: claimId }).where(eq(agentFreshStartGrants.messageId, message.id));
      }
      if (input.outcome === 'accepted' && relayGeneration != null && message.status === 'leased') {
        const [remote] = await tx.select().from(hostDaemonSessions)
          .where(eq(hostDaemonSessions.addressId, message.targetAddressId));
        if (remote?.activeMessageId === message.id) {
          const [daemon] = await tx.select().from(hostDaemons).where(eq(hostDaemons.hostId, remote.hostId)).for('update');
          if (!daemon || !daemonAccepting(daemon.settings))
            throw new ConflictError('Host daemon deadline expired or disabled', 'daemon_disabled');
        }
      }
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
          patch = { ...shared, status: 'accepted', acceptedAt: message.kind === 'schedule' ? now : message.acceptedAt ?? now, leaseUntil: isoOffsetSeconds(AGENT_MESSAGING_LEASE_SECONDS) };
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
      if (input.outcome === 'completed' && message.workKind) {
        const report = await storeTaskResult(tx, message, input.taskResult ?? unknownTaskResult, this.keyring, now);
        patch.taskResultStatus = report.status;
        if (input.taskResult) await queueTaskResultReply(tx, message, report, this.keyring, now, {
          requireAddressLocked: (db, addressId) => this.requireAddressLocked(db, addressId),
          requireConversationLocked: (db, conversationId) => this.requireConversationLocked(db, conversationId),
          chargeConferenceBudgetLocked: (db, conversationId, timestamp) => this.conference.chargeConferenceBudgetLocked(db, conversationId, timestamp),
        });
        await this.conference.settleConferenceDispatchLocked(tx, message.id, now);
      }
      await tx.update(agentBusMessages).set(patch).where(eq(agentBusMessages.id, id));
      if (input.outcome === 'completed') await presentDigest(tx, message, now);
      if (upstreamSessionId && input.outcome !== 'retry' && input.outcome !== 'dead') {
        const targetRows = await tx
          .select()
          .from(agentBusAddresses)
          .where(eq(agentBusAddresses.id, message.targetAddressId))
          .limit(1)
          .for('update');
        const target = targetRows[0];
        if (target) {
          await assertHousekeepingAvailable(tx, target.hostId, target.engine);
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

  async authenticateBridge(sessionId: string, rawToken: string, allowEnded = false): Promise<{ session: AgentSession; host: Host }> {
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
    assertHostEngineEnabled(row.host, row.session.engine as Engine, await readFleetEngineState(this.db));
    if (row.session.endedAt && !allowEnded) throw await agentSessionFinishedError(this.db, row.session);
    if (!row.session.endedAt && row.session.bridgeExpiresAt <= nowIso()) throw new UnauthorizedError('Agent bridge credential expired', 'agent_bridge_expired');
    return row;
  }

  /**
   * `requirePersistent` gates heartbeat and claim: a per-user relay resumes dormant agents headless, which is remote
   * execution and exists only on a persistent host (docs/host-runtime-policy.md); a host-daemon relay instead re-checks
   * the registration gate (daemonAccepting) unless it is draining. The host-daemon row rides on the
   * same query, so the hot polling path stays one statement. Stop, renew, reply and ack pass false so in-flight work
   * can finish and be recorded.
   */
  private async authenticateRelay(relayId: string, rawToken: string, requirePersistent = false): Promise<AgentBusRelay> {
    await this.requireEnabled();
    const id = normalizeUuid(relayId, 'relay_id');
    const rows = await this.db
      .select({ relay: agentBusRelays, host: hosts, daemon: hostDaemons.settings })
      .from(agentBusRelays)
      .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
      .leftJoin(hostDaemons, eq(hostDaemons.hostId, agentBusRelays.hostId))
      .where(eq(agentBusRelays.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.relay.status !== 'active' || !row.relay.tokenHash || !safeHashEqual(sha256(rawToken ?? ''), row.relay.tokenHash)) {
      throw new UnauthorizedError('Invalid agent relay credential', 'agent_messaging_relay_unauthorized');
    }
    this.assertEligibleHost(row.host);
    if (row.relay.tokenExpiresAt == null || row.relay.tokenExpiresAt <= nowIso()) throw new UnauthorizedError('Agent relay credential expired', 'agent_messaging_relay_expired');
    if (!safeHashEqual(hostAuthFingerprint(row.host), row.relay.hostAuthFingerprint)) throw new UnauthorizedError('Agent relay host credential changed', 'agent_messaging_relay_host_auth_changed');
    if (requirePersistent) {
      if (jsonRecord(row.relay.capabilities)?.host_daemon === true) {
        if (!(row.daemon && daemonAccepting(row.daemon)) && !(await this.daemonRelayDraining(row.relay.hostId))) {
          throw new ForbiddenError('Daemon relay is not enabled');
        }
      } else if (!(row.daemon && daemonResidentFor(row.daemon, row.relay.username))) {
        throw notPersistentRelay();
      }
    }
    return row.relay;
  }

  /**
   * A daemon relay outside its registration gate (disabled, timed deadline passed, migration fence) keeps heartbeat
   * and claim only while accepted work drains: the wrapper runs every turn under the poll context that a heartbeat
   * or claim error cancels, and the 15-minute token must stay valid so the result can still be recorded. claimDelivery
   * hands such a relay no new work. Mirrors HostDaemonService.migration's readiness count.
   */
  private async daemonRelayDraining(hostId: number): Promise<boolean> {
    const work = await this.db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, hostId));
    if (work.some((s) => s.status === 'running' || s.status === 'stopping')) return true;
    const addresses = work.map((s) => s.addressId).filter((a): a is string => Boolean(a));
    if (addresses.length === 0) return false;
    const claims = await this.db
      .select({ id: agentBusMessages.id })
      .from(agentBusMessages)
      .where(and(inArray(agentBusMessages.targetAddressId, addresses), inArray(agentBusMessages.status, ['leased', 'accepted'])))
      .limit(1);
    return claims.length > 0;
  }

  /** Registration gate for a per-user relay; see authenticateRelay. */
  private async assertPersistentHost(hostId: number, username: string): Promise<void> {
    const [daemon] = await this.db.select().from(hostDaemons).where(eq(hostDaemons.hostId, hostId)).limit(1);
    if (!daemon || !daemonResidentFor(daemon.settings, username)) throw notPersistentRelay();
  }

  /**
   * Lock a session for a transaction that will also lock its host. The order
   * is hosts -> agent_sessions everywhere (portal bridge, registration,
   * heartbeat via the housekeeping guard); taking the session first deadlocked
   * a session claim against a concurrent /activity report. host_id never
   * changes, so the unlocked read only picks which host row to lock.
   */
  private async lockSessionHostFirst(db: AgentMessagingDb, sessionId: string): Promise<AgentSession | undefined> {
    const [owner] = await db.select({ hostId: agentSessions.hostId }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    if (!owner) return undefined;
    await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, owner.hostId)).limit(1).for('update');
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    return rows[0];
  }

  private async requireBridgeSessionLocked(db: AgentMessagingDb, sessionId: string, rawToken: string, hostId: number): Promise<AgentSession> {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).for('update');
    const session = rows[0];
    if (!session || session.hostId !== hostId || !safeHashEqual(sha256(rawToken ?? ''), session.bridgeTokenHash)) {
      throw new UnauthorizedError('Invalid agent bridge credential', 'agent_bridge_unauthorized');
    }
    if (session.endedAt) throw await agentSessionFinishedError(db, session);
    return session;
  }

  private async requireAddressLocked(db: AgentMessagingDb, id: string): Promise<AgentBusAddress> {
    const rows = await db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1).for('update');
    const address = rows[0];
    if (!address) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    return address;
  }

  private async resolveAddressLocked(db: AgentMessagingDb, raw: string, forUpdate: boolean, allowInactive = false): Promise<AgentBusAddress> {
    let value = String(raw ?? '').trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) value = `agent:${value}`;
    const nameInput = value && !value.startsWith('agent:') ? value : null;
    if (nameInput) value = String((await translateAgent(db, nameInput)).address);
    if (!value) throw new ValidationError('to is required', { param: 'to' });
    const query = db
      .select()
      .from(agentBusAddresses)
      .where(or(eq(agentBusAddresses.address, value), eq(agentBusAddresses.displayAlias, value)))
      .limit(1);
    const rows = forUpdate ? await query.for('update') : await query;
    const address = rows[0];
    if (!address || (!allowInactive && (address.archivedAt || address.enabled !== 1))) {
      throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    }
    if (nameInput && forUpdate) {
      const confirmed = await translateAgent(db, nameInput, true);
      if (confirmed.uuid !== address.id) throw new ConflictError('Name assignment changed; resolve it again', 'agent_name_changed');
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
    if (!activeHostEngines(rows[0].engines, await readFleetEngineState(db)).includes(address.engine as Engine)) {
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

  /** Shared bus lock orders room membership, recipient snapshots and claim transitions. */
  async coordinationTransaction<T>(sessionId: string | null, token: string | null,
    action: (tx: AgentMessagingDb, session: AgentSession | null) => Promise<T>,
    options?: { isolationLevel: 'repeatable read' }): Promise<T> {
    if (sessionId) await this.authenticateBridge(sessionId, token!);
    return this.db.transaction(async tx => {
      await this.requireEnabledLocked(tx);
      let session: AgentSession | null = null;
      if (sessionId) {
        const rows = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
        session = rows[0] ?? null;
        if (!session?.agentBusAddressId) throw new ConflictError('Session is not bound', 'agent_messaging_binding_stale');
        const address = await this.requireAddressLocked(tx, session.agentBusAddressId);
        const currentHost = await this.requireEligibleHostLocked(tx, session.hostId);
        if (!safeHashEqual(sha256(token!), session.bridgeTokenHash) || !safeHashEqual(hostAuthFingerprint(currentHost), session.hostAuthFingerprint) || session.bridgeExpiresAt <= nowIso()) throw new UnauthorizedError('Agent credential changed', 'agent_bridge_unauthorized');
        await this.assertSessionAddressLocked(tx, sessionId, address);
      }
      return action(tx, session);
    }, options);
  }

  /** Workflow collaboration joins the same bus transaction before taking run locks. */
  async workflowLock(db: AgentMessagingDb, actor: { kind: string; address_id?: string; session_id?: string; binding_generation?: number }): Promise<void> {
    if (actor.kind !== 'agent') {
      // Operator preparation/recovery and the module switch remain available when messaging is off.
      await db.select().from(versions).where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY)).for('update');
      return;
    }
    await this.requireEnabledLocked(db);
    if (!actor.address_id || !actor.session_id) throw new UnauthorizedError('Authenticated workflow actor required');
    const address = await this.requireAddressLocked(db, actor.address_id);
    await this.assertSessionAddressLocked(db, actor.session_id, address);
    await this.workflowTarget(db, actor.address_id);
    if (address.bindingGeneration !== actor.binding_generation)
      throw new ConflictError('Agent binding changed', 'agent_messaging_binding_stale');
  }

  async workflowTarget(db: AgentMessagingDb, addressId: string) {
    const address = await this.requireAddressLocked(db, addressId);
    await this.assertAddressEligibleLocked(db, address);
    if (!address.currentSessionId) throw new ConflictError('Workflow invitation requires an active session', 'workflow_target_unavailable');
    await this.assertSessionAddressLocked(db, address.currentSessionId, address);
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, address.currentSessionId)).limit(1);
    if (!session || session.bindingGeneration !== address.bindingGeneration)
      throw new ConflictError('Agent binding changed', 'agent_messaging_binding_stale');
    const host = await this.requireEligibleHostLocked(db, session.hostId);
    const runningVersion = hostRunningWrapperVersion(host);
    if (!runningVersion || compareWrapperVersions(runningVersion, WORKFLOWS_MIN_CXX_VERSION) < 0)
      throw new ConflictError('Update this host wrapper before workflow participation', 'workflow_wrapper_outdated');
    if (Number((session.adapterCapabilities as Record<string, unknown> | null)?.workflow_protocol_version ?? 0) < 1)
      throw new ConflictError('Update this agent wrapper before workflow participation', 'workflow_wrapper_outdated');
    return { address, session };
  }

  async coordinationNotice(tx: AgentMessagingDb, session: AgentSession, content: string, roomQuestion = false, clientMessageId?: string, noticeOptions: { deliveryClass?: 'notice' | 'coordination'; ttlSeconds?: number } = {}): Promise<string | undefined> {
    if (!session.agentBusAddressId || session.endedAt) return;
    const target = await this.requireAddressLocked(tx, session.agentBusAddressId);
    if (target.currentSessionId !== session.id) return;
    try { await this.assertAddressEligibleLocked(tx, target); }
    catch (error) { if (error instanceof ApiError && [403, 404, 423].includes(error.status)) return; throw error; }
    const sender = await this.groups.server(tx);
    const now = nowIso(), conversationId = randomUUID(), messageId = randomUUID();
    await tx.insert(agentBusConversations).values({ id: conversationId, addressAId: sender.id, addressBId: target.id, createdByAddressId: sender.id, nextSequence: 2, status: 'open', lastActivityAt: now, createdAt: now, updatedAt: now });
    await tx.insert(agentBusMessages).values({
      ...newQueuedMessage({ id: messageId, conversationId, sequence: 1, sender, senderSessionId: null, target,
        kind: roomQuestion ? 'message' : 'presence_notice', deliveryClass: roomQuestion ? 'coordination' : noticeOptions.deliveryClass ?? 'notice', content, contentEnc: encrypt(content, this.keyring),
        clientMessageId: clientMessageId ?? randomUUID(), expiresAt: new Date(Date.now() + (noticeOptions.ttlSeconds ?? 86400) * 1000).toISOString(), now }),
      targetSessionId: session.id,
      targetBindingGeneration: target.bindingGeneration,
    });
    return messageId;
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
    // hosts before agent_sessions, see lockSessionHostFirst; the eligibility
    // check below re-locks the same host row.
    await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, address.hostId)).limit(1).for('update');
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

/** 503, not 403: workers before cxx 0.9.82 back off 30 s on a 503 but retry a 403 every 3 s. */
function notPersistentRelay(): ServiceUnavailableError {
  return new ServiceUnavailableError('Agent relays run only on persistent hosts', 'agent_messaging_relay_not_persistent');
}
