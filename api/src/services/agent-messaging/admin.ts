import { deriveAddressPresence } from '../agent-presence.js';
import { receiverView } from '../agent-receiver-state.js';
/**
 * The operator's view of the bus: the fleet switch, and the admin console's
 * read and repair surface.
 *
 * Split out of `../agent-messaging.ts`. Nothing here is on a host's hot path --
 * it is counted rows, alias edits, one revealed message body, and the two
 * levers (cancel, redrive) an operator pulls when a conversation is stuck.
 */

import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
  versions,
  type AgentBusAddress,
  type AgentBusConversation,
  type AgentBusMessage,
} from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import type { Keyring } from '../../security/keyring.js';
import { ENGINE_CLAUDE, ENGINE_CODEX, type Engine } from '../../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { isTruthyFlagValue } from '../settings.js';
import { wsPublisher } from '../../ws/publisher.js';
import { hostEnginesList } from '../host-engine-policy.js';
import type { SettingsService } from '../settings.js';
import {
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_ENABLED_KEY,
  CANCELABLE_MESSAGE_STATUSES,
  LIVE_MESSAGE_STATUSES,
  AGENT_MESSAGING_RECEIVE_FRESH_SECONDS,
} from './constants.js';
import { addressIneligibleReason, messagingHostEligible } from './eligibility.js';
import { normalizeAgentAlias, normalizeUuid } from './normalize.js';
import { isDuplicateKeyError } from './internals.js';
import type { AgentMessagingDb } from './types.js';
import { conversationMetadata, messageMetadata, publicAddress } from './views.js';

/**
 * What the operator surface borrows from the bus. Everything here is read or
 * repair; none of it may invent a new way to move a message.
 */
export interface AdminCore {
  readonly db: Database;
  readonly keyring: Keyring;
  readonly settings: SettingsService;
  isEnabled(): Promise<boolean>;
  requireEnabled(): Promise<void>;
  requireEnabledLocked(db: AgentMessagingDb): Promise<void>;
  requireConversationLocked(db: AgentMessagingDb, id: string): Promise<AgentBusConversation>;
  decodeContent(message: Pick<AgentBusMessage, 'contentEnc'>): string;
  cancelConversationInternal(
    conversationId: string,
    canceledBy: string,
    reason: string,
    participantAddressId?: string,
    participantSessionId?: string,
  ): Promise<Record<string, unknown>>;
  addressMap(ids: string[]): Promise<Map<string, AgentBusAddress>>;
  assertConversationParticipants(conversation: AgentBusConversation, first: string, second: string): void;
}

export class AgentMessagingAdmin {
  constructor(private readonly core: AdminCore) {}

  async state(): Promise<Record<string, unknown>> {
    const enabled = await this.core.isEnabled();
    const now = nowIso();
    const freshAfter = isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS);
    const [addressRows, relayRows, queued, leased, accepted, dead, ambiguous, conversations, directionRows] =
      await Promise.all([
        this.core.db
          .select({
            address: agentBusAddresses,
            session: agentSessions,
            engine: agentBusAddresses.engine,
            receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
            hostStatus: hosts.status,
            hostSecure: hosts.secure,
            hostWindowUntil: hosts.insecureEnabledUntil,
            hostEngines: hosts.engines,
          })
          .from(agentBusAddresses)
          .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
          .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
          .where(and(eq(agentBusAddresses.enabled, 1), isNull(agentBusAddresses.archivedAt))),
        this.core.db
          .select({
            tokenExpiresAt: agentBusRelays.tokenExpiresAt,
            hostStatus: hosts.status,
            hostSecure: hosts.secure,
            hostWindowUntil: hosts.insecureEnabledUntil,
          })
          .from(agentBusRelays)
          .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
          .where(eq(agentBusRelays.status, 'active')),
        this.core.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'queued')),
        this.core.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'leased')),
        this.core.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'accepted')),
        this.core.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'dead')),
        this.core.db.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'ambiguous')),
        this.core.db.select({ value: count() }).from(agentBusConversations).where(eq(agentBusConversations.status, 'open')),
        this.core.db
          .select({ sourceEngine: agentBusMessages.sourceEngine, targetEngine: agentBusMessages.targetEngine, status: agentBusMessages.status, value: count() })
          .from(agentBusMessages)
          .groupBy(agentBusMessages.sourceEngine, agentBusMessages.targetEngine, agentBusMessages.status),
      ]);
    const eligibleAddresses = enabled
      ? addressRows.filter((row) =>
        messagingHostEligible({
          status: row.hostStatus,
          secure: row.hostSecure,
          insecureEnabledUntil: row.hostWindowUntil,
        }) &&
        hostEnginesList(row.hostEngines).includes(row.engine as Engine),
      )
      : [];
    const eligibleRelays = enabled
      ? relayRows.filter((row) =>
        messagingHostEligible({
          status: row.hostStatus,
          secure: row.hostSecure,
          insecureEnabledUntil: row.hostWindowUntil,
        }) &&
        row.tokenExpiresAt != null &&
        row.tokenExpiresAt > now,
      )
      : [];
    const directions = [ENGINE_CODEX, ENGINE_CLAUDE].flatMap((sourceEngine) =>
      [ENGINE_CODEX, ENGINE_CLAUDE].map((targetEngine) => {
        const matching = directionRows.filter((row) => row.sourceEngine === sourceEngine && row.targetEngine === targetEngine);
        const value = (statuses: readonly string[]) => matching
          .filter((row) => statuses.includes(row.status))
          .reduce((sum, row) => sum + Number(row.value), 0);
        return {
          source_engine: sourceEngine,
          target_engine: targetEngine,
          total: value(matching.map((row) => row.status)),
          pending: value(LIVE_MESSAGE_STATUSES),
          completed: value(['completed']),
          dead: value(['dead']),
          ambiguous: value(['ambiguous']),
        };
      }),
    );
    return {
      enabled,
      initial_default: false,
      addresses: eligibleAddresses.length,
      live_addresses: eligibleAddresses.filter((row) => deriveAddressPresence(row.address,row.session,freshAfter) === 'listening').length,
      relays: eligibleRelays.length,
      open_conversations: Number(conversations[0]?.value ?? 0),
      messages: {
        queued: Number(queued[0]?.value ?? 0),
        leased: Number(leased[0]?.value ?? 0),
        accepted: Number(accepted[0]?.value ?? 0),
        dead: Number(dead[0]?.value ?? 0),
        ambiguous: Number(ambiguous[0]?.value ?? 0),
      },
      directions,
      delivery: 'ordered_at_least_once',
    };
  }

  async setEnabled(enabled: boolean): Promise<Record<string, unknown>> {
    const now = nowIso();
    const result = await this.core.db.transaction(async (tx) => {
      const rows = await tx
        .select({ version: versions.version })
        .from(versions)
        .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY))
        .limit(1)
        .for('update');
      if (rows.length === 0) {
        await tx.insert(versions).values({
          name: AGENT_MESSAGING_ENABLED_KEY,
          version: enabled ? '1' : '0',
          updatedAt: now,
        });
      } else {
        await tx
          .update(versions)
          .set({ version: enabled ? '1' : '0', updatedAt: now })
          .where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY));
      }
      // The signed wrapper payload carries the effective messaging policy.
      // Mark every host stale on either edge so the normal config refresh path
      // converges without an operator reinstall.
      await tx
        .update(hosts)
        .set({ configVersion: sql`${hosts.configVersion} + 1`, updatedAt: now });
      if (enabled) {
        return { canceled: 0, ambiguous: 0, conversations: 0, relays: 0, bindings: 0 };
      }
      const [pending, uncertain, open, relayRows, bound] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES])),
        tx.select({ value: count() }).from(agentBusMessages).where(eq(agentBusMessages.status, 'accepted')),
        tx.select({ value: count() }).from(agentBusConversations).where(eq(agentBusConversations.status, 'open')),
        tx.select({ value: count() }).from(agentBusRelays).where(eq(agentBusRelays.status, 'active')),
        tx.select({ value: count() }).from(agentBusAddresses).where(or(isNull(agentBusAddresses.archivedAt), ne(agentBusAddresses.readiness, 'disabled'))),
      ]);
      await tx
        .update(agentBusMessages)
        .set({
          status: 'canceled',
          cancelRequestedAt: now,
          canceledAt: now,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]));
      await tx
        .update(agentBusMessages)
        .set({
          status: 'ambiguous',
          ambiguousAt: now,
          lastErrorCode: 'master_disabled_after_accept',
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(eq(agentBusMessages.status, 'accepted'));
      await tx
        .update(agentBusConversations)
        .set({
          status: 'canceled',
          canceledBy: 'system:master-switch',
          cancelReason: 'Agent Messaging disabled',
          canceledAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusConversations.status, 'open'));
      await tx
        .update(agentBusRelays)
        .set({
          status: 'revoked',
          tokenHash: null,
          tokenExpiresAt: null,
          stopRequestedAt: now,
          updatedAt: now,
        })
        .where(eq(agentBusRelays.status, 'active'));
      await tx
        .update(agentBusAddresses)
        .set({
          currentSessionId: null,
          readiness: 'disabled',
          receiveHeartbeatAt: null,
          callPin: null,
          callPinExpiresAt: null,
          bindingGeneration: sql`${agentBusAddresses.bindingGeneration} + 1`,
          updatedAt: now,
        })
        .where(isNull(agentBusAddresses.archivedAt));
      await tx
        .update(agentSessions)
        .set({
          adapterProtocol: null,
          adapterCapabilities: null,
          receiveHeartbeatAt: null,
          bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
          updatedAt: now,
        });
      return {
        canceled: Number(pending[0]?.value ?? 0),
        ambiguous: Number(uncertain[0]?.value ?? 0),
        conversations: Number(open[0]?.value ?? 0),
        relays: Number(relayRows[0]?.value ?? 0),
        bindings: Number(bound[0]?.value ?? 0),
      };
    });
    wsPublisher.publish('agent_messaging.state.changed', { enabled, ...result });
    wsPublisher.publish('settings.changed', { key: AGENT_MESSAGING_ENABLED_KEY });
    return { enabled, ...result };
  }

  async listAdminAddresses(): Promise<Record<string, unknown>> {
    const masterEnabled = await this.core.isEnabled();
    const rows = await this.core.db
      .select({
        address: agentBusAddresses,
        session: agentSessions,
        fqdn: hosts.fqdn,
        hostSecure: hosts.secure,
        hostStatus: hosts.status,
        hostWindowUntil: hosts.insecureEnabledUntil,
        hostEngines: hosts.engines,
      })
      .from(agentBusAddresses)
      .innerJoin(hosts, eq(hosts.id, agentBusAddresses.hostId))
      .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
      .where(isNull(agentBusAddresses.archivedAt))
      .orderBy(desc(agentBusAddresses.lastSeenAt));
    const queueRows = await this.core.db
      .select({ targetAddressId: agentBusMessages.targetAddressId, value: count() })
      .from(agentBusMessages)
      .where(inArray(agentBusMessages.status, [...LIVE_MESSAGE_STATUSES]))
      .groupBy(agentBusMessages.targetAddressId);
    const queues = new Map(queueRows.map((row) => [row.targetAddressId, Number(row.value)]));
    return {
      addresses: rows.map((row) => ({
        ...publicAddress(row.address, row.fqdn, deriveAddressPresence(row.address,row.session,isoOffsetSeconds(-45))),
        receiver: receiverView(row.session?.receiver),
        current_session_id: row.address.currentSessionId,
        host_secure: row.hostSecure === 1,
        host_status: row.hostStatus,
        host_window_until: row.hostWindowUntil,
        host_engines: hostEnginesList(row.hostEngines),
        eligible:
          masterEnabled &&
          messagingHostEligible({
            status: row.hostStatus,
            secure: row.hostSecure,
            insecureEnabledUntil: row.hostWindowUntil,
          }) &&
          hostEnginesList(row.hostEngines).includes(row.address.engine as Engine),
        ineligible_reason: addressIneligibleReason(
          masterEnabled,
          messagingHostEligible({
            status: row.hostStatus,
            secure: row.hostSecure,
            insecureEnabledUntil: row.hostWindowUntil,
          }),
          row.hostSecure === 1,
          row.hostStatus,
          hostEnginesList(row.hostEngines),
          row.address.engine as Engine,
        ),
        queue_depth: queues.get(row.address.id) ?? 0,
      })),
    };
  }

  async setAddressAlias(addressId: string, displayAlias: string | null): Promise<Record<string, unknown>> {
    const id = normalizeUuid(addressId, 'address_id');
    const alias = normalizeAgentAlias(displayAlias);
    const now = nowIso();
    const rows = await this.core.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1);
    if (!rows[0] || rows[0].archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
    try {
      await this.core.db.update(agentBusAddresses).set({ displayAlias: alias, updatedAt: now }).where(eq(agentBusAddresses.id, id));
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new ConflictError('Agent alias already exists', 'agent_messaging_alias_conflict');
      throw error;
    }
    wsPublisher.publish('agent_messaging.address.changed', { address_id: id });
    return { address: { ...publicAddress(rows[0]), alias } };
  }

  async setAddressEnabled(addressId: string, enabled: boolean): Promise<Record<string, unknown>> {
    const id = normalizeUuid(addressId, 'address_id');
    const now = nowIso();
    const result = await this.core.db.transaction(async (tx) => {
      const rows = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, id)).limit(1).for('update');
      const address = rows[0];
      if (!address || address.archivedAt) throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
      if (enabled) {
        const [stateRows, hostRows] = await Promise.all([
          tx.select({ version: versions.version }).from(versions).where(eq(versions.name, AGENT_MESSAGING_ENABLED_KEY)).limit(1).for('update'),
          tx.select().from(hosts).where(eq(hosts.id, address.hostId)).limit(1).for('update'),
        ]);
        if (!isTruthyFlagValue(stateRows[0]?.version, false)) {
          throw new ConflictError('Agent Messaging is disabled', 'agent_messaging_disabled');
        }
        const host = hostRows[0];
        if (
          !host ||
          !messagingHostEligible(host) ||
          !hostEnginesList(host.engines).includes(address.engine as Engine)
        ) {
          throw new ConflictError('Agent Messaging requires an eligible active host', 'agent_messaging_host_ineligible');
        }
      }
      await tx
        .update(agentBusAddresses)
        .set({
          enabled: enabled ? 1 : 0,
          currentSessionId: enabled ? address.currentSessionId : null,
          // A disabled address must not stay dialable.
          callPin: enabled ? address.callPin : null,
          callPinExpiresAt: enabled ? address.callPinExpiresAt : null,
          readiness: enabled
            ? address.currentSessionId
              ? address.readiness
              : address.lastUpstreamSessionId
                ? 'resumable'
                : 'offline'
            : 'disabled',
          receiveHeartbeatAt: enabled ? address.receiveHeartbeatAt : null,
          bindingGeneration: enabled ? address.bindingGeneration : address.bindingGeneration + 1,
          updatedAt: now,
        })
        .where(eq(agentBusAddresses.id, id));
      if (enabled) return { canceled: 0, ambiguous: 0 };
      const scope = or(eq(agentBusMessages.senderAddressId, id), eq(agentBusMessages.targetAddressId, id));
      const [pending, uncertain] = await Promise.all([
        tx.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), scope)),
        tx.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), scope)),
      ]);
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), scope));
      await tx
        .update(agentBusMessages)
        .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: 'address_disabled_after_accept', leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(and(eq(agentBusMessages.status, 'accepted'), scope));
      await tx
        .update(agentBusConversations)
        .set({
          status: 'canceled',
          canceledBy: 'system:address-disabled',
          cancelReason: 'Agent address disabled',
          canceledAt: now,
          updatedAt: now,
        })
        .where(and(eq(agentBusConversations.status, 'open'), or(eq(agentBusConversations.addressAId, id), eq(agentBusConversations.addressBId, id))));
      await tx
        .update(agentSessions)
        .set({ adapterProtocol: null, adapterCapabilities: null, receiveHeartbeatAt: null, bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`, updatedAt: now })
        .where(eq(agentSessions.agentBusAddressId, id));
      return { canceled: Number(pending[0]?.value ?? 0), ambiguous: Number(uncertain[0]?.value ?? 0) };
    });
    wsPublisher.publish('agent_messaging.address.changed', { address_id: id, enabled, ...result });
    return { address_id: id, enabled, ...result };
  }

  async listAdminConversations(options: { status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const rows = options.status
      ? await this.core.db.select().from(agentBusConversations).where(eq(agentBusConversations.status, options.status)).orderBy(desc(agentBusConversations.lastActivityAt)).limit(limit)
      : await this.core.db.select().from(agentBusConversations).orderBy(desc(agentBusConversations.lastActivityAt)).limit(limit);
    const addresses = await this.core.addressMap(rows.flatMap((row) => [row.addressAId, row.addressBId]));
    return {
      conversations: rows.map((row) => ({
        ...conversationMetadata(row),
        address_a: publicAddress(addresses.get(row.addressAId)!),
        address_b: publicAddress(addresses.get(row.addressBId)!),
      })),
    };
  }

  async listAdminMessages(options: { conversationId?: string; status?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const predicates = [];
    if (options.conversationId) predicates.push(eq(agentBusMessages.conversationId, normalizeUuid(options.conversationId, 'conversation_id')));
    if (options.status) predicates.push(eq(agentBusMessages.status, options.status));
    const rows = predicates.length > 0
      ? await this.core.db.select().from(agentBusMessages).where(and(...predicates)).orderBy(desc(agentBusMessages.createdAt)).limit(limit)
      : await this.core.db.select().from(agentBusMessages).orderBy(desc(agentBusMessages.createdAt)).limit(limit);
    const addresses = await this.core.addressMap(rows.flatMap((row) => [row.senderAddressId, row.targetAddressId]));
    return {
      messages: rows.map((row) => messageMetadata(row, addresses.get(row.senderAddressId), addresses.get(row.targetAddressId))),
    };
  }

  async revealMessage(messageId: string): Promise<Record<string, unknown>> {
    const id = normalizeUuid(messageId, 'message_id');
    const rows = await this.core.db.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1);
    const message = rows[0];
    if (!message) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
    return { message_id: id, content: this.core.decodeContent(message) };
  }

  async adminCancelConversation(conversationId: string, reason?: string | null): Promise<Record<string, unknown>> {
    const id = normalizeUuid(conversationId, 'conversation_id');
    const result = await this.core.cancelConversationInternal(id, 'admin', reason ?? 'Canceled by administrator');
    wsPublisher.publish('agent_messaging.conversation.changed', { conversation_id: id, status: 'canceled' });
    return result;
  }

  async redriveMessage(messageId: string): Promise<Record<string, unknown>> {
    await this.core.requireEnabled();
    const id = normalizeUuid(messageId, 'message_id');
    const result = await this.core.db.transaction(async (tx) => {
      await this.core.requireEnabledLocked(tx);
      const rows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, id)).limit(1).for('update');
      const original = rows[0];
      if (!original) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
      if (original.status !== 'dead' && original.status !== 'ambiguous') {
        throw new ConflictError('Only dead or ambiguous messages can be redriven', 'agent_messaging_redrive_not_allowed');
      }
      const conversation = await this.core.requireConversationLocked(tx, original.conversationId);
      if (conversation.status !== 'open') throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
      const now = nowIso();
      const sequence = Number(conversation.nextSequence);
      const { dispatchOrder: _originalDispatchOrder, ...originalForRedrive } = original;
      const redriveId = randomUUID();
      const redrive: typeof agentBusMessages.$inferInsert = {
        ...originalForRedrive,
        id: redriveId,
        sequence,
        redriveOfMessageId: original.id,
        clientMessageId: randomUUID(),
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
      await tx.insert(agentBusMessages).values(redrive);
      const persistedRows = await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, redriveId)).limit(1);
      const persisted = persistedRows[0];
      if (!persisted) throw new Error('Redriven agent message could not be read back');
      await tx.update(agentBusConversations).set({ nextSequence: sequence + 1, lastActivityAt: now, updatedAt: now }).where(eq(agentBusConversations.id, conversation.id));
      return persisted;
    });
    wsPublisher.publish('agent_messaging.message.changed', { message_id: result.id, conversation_id: result.conversationId, status: 'queued', redrive_of: id });
    return { message: messageMetadata(result), redrive_of_message_id: id };
  }
}
