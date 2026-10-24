import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agentBusMessages, versions } from '../../db/schema.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';
import { mutateOwnerState, requireOwnerRuntime } from '../../control-plane/state/runtime.js';
import {
  ownedAddress,
  requireOwnedMessaging,
  ownedEngineState,
} from '../../control-plane/state/messaging.js';
import { stageUpdate } from '../../control-plane/state/rows.js';
import { adminAudit } from '../../control-plane/state/admin.js';
import { suspendOwnedMessaging } from '../../control-plane/state/suspension.js';
import { stageQueuedMessage } from '../../control-plane/state/messages.js';
import { ownedAddressPresence } from '../../control-plane/state/presence-notices.js';
import { activeHostEngines, hostEnginesList } from '../host-engine-policy.js';
import { receiverView } from '../agent-receiver-state.js';
import { isTruthyFlagValue } from '../settings.js';
import { messagingHostEligible, addressIneligibleReason } from './eligibility.js';
import { normalizeAgentAlias, normalizeUuid } from './normalize.js';
import { agentNameKey } from './names.js';
import { SERVER_ADDRESS_ID } from './groups.js';
import {
  AGENT_MESSAGING_DEFAULT_TTL_SECONDS,
  AGENT_MESSAGING_ENABLED_KEY,
  LIVE_MESSAGE_STATUSES,
} from './constants.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import { publicAddress, conversationMetadata, messageMetadata } from './views.js';
import type { AdminCore } from './admin.js';
import type { Json } from '../../control-plane/commands.js';
import type { Engine } from '../../util/engine.js';
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

export class OwnedMessagingAdmin {
  readonly runtime;
  constructor(private core: AdminCore) {
    this.runtime = requireOwnerRuntime(core.db);
  }
  async setEnabled(enabled: boolean) {
    return mutateOwnerState(this.runtime, {
      kind: 'messaging.admin.enabled',
      payload: { enabled },
      prepare(ctx) {
        const now = nowIso(),
          setting = { name: AGENT_MESSAGING_ENABLED_KEY, version: enabled ? '1' : '0', updatedAt: now },
          result = { canceled: 0, ambiguous: 0, conversations: 0, relays: 0, bindings: 0 };
        ctx.draft.upsert('versions', setting);
        ctx.write((tx) => tx.insert(versions).values(setting).onDuplicateKeyUpdate({ set: setting }));
        for (const host of ctx.snapshot.hosts.all()) {
          stageUpdate(ctx, 'hosts', host.id, { configVersion: host.configVersion + 1, updatedAt: now });
          if (!enabled) {
            const changed = suspendOwnedMessaging(ctx, host.id, 'messaging_disabled', undefined, now);
            for (const key of Object.keys(result) as Array<keyof typeof result>) result[key] += changed[key];
          }
        }
        adminAudit(ctx, 'agent_messaging.enabled', { enabled, ...result });
        return { enabled, ...result };
      },
    });
  }
  addresses() {
    const snapshot = this.runtime.state.snapshot(),
      enabled = isTruthyFlagValue(snapshot.setting(AGENT_MESSAGING_ENABLED_KEY)),
      fleet = ownedEngineState(snapshot);
    return {
      addresses: snapshot.addresses
        .all()
        .filter(
          (row) =>
            !row.archivedAt &&
            snapshot.hosts.has(row.hostId) &&
            !snapshot.hosts.get(row.hostId)?.internalRole,
        )
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .map((address) => {
          const host = snapshot.hosts.get(address.hostId)!,
            session = address.currentSessionId ? snapshot.sessions.get(address.currentSessionId) : undefined,
            engines = activeHostEngines(host.engines, fleet),
            eligible = messagingHostEligible(host);
          return {
            ...publicAddress(address, host.fqdn, ownedAddressPresence(this.runtime, snapshot, address)),
            receiver: receiverView(session?.receiver),
            current_session_id: address.currentSessionId,
            host_secure: host.secure === 1,
            host_status: host.status,
            host_window_until: host.insecureEnabledUntil,
            host_engines: hostEnginesList(host.engines),
            eligible: enabled && eligible && engines.includes(address.engine as Engine),
            ineligible_reason: addressIneligibleReason(
              enabled,
              eligible,
              host.secure === 1,
              host.status,
              engines,
              address.engine as Engine,
            ),
            queue_depth: snapshot.messages
              .by('targetAddressId', address.id)
              .filter((row) => (LIVE_MESSAGE_STATUSES as readonly string[]).includes(row.status)).length,
          };
        }),
    };
  }
  async alias(addressId: string, displayAlias: string | null) {
    const id = normalizeUuid(addressId, 'address_id'),
      alias = normalizeAgentAlias(displayAlias);
    if (id === SERVER_ADDRESS_ID)
      throw new ConflictError('Server is a reserved publisher', 'agent_messaging_server_identity_readonly');
    return mutateOwnerState(this.runtime, {
      kind: 'messaging.admin.alias',
      payload: { id, alias },
      prepare(ctx) {
        const row = ctx.snapshot.addresses.get(id);
        if (!row || row.archivedAt)
          throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
        const key = alias ? agentNameKey(alias.replace(/^agent:/, '')) : null;
        if (
          key &&
          ctx.snapshot
            .table('agentNamePool')
            .all()
            .some((slot) => slot.nameKey === key)
        )
          throw new ConflictError(
            'Alias is reserved for automatic launch names',
            'agent_messaging_alias_reserved',
          );
        if (
          key &&
          ctx.snapshot.addresses
            .all()
            .some(
              (other) =>
                other.id !== id &&
                other.displayAlias &&
                agentNameKey(other.displayAlias.replace(/^agent:/, '')) === key,
            )
        )
          throw new ConflictError('Agent alias already exists', 'agent_messaging_alias_conflict');
        const next = stageUpdate(ctx, 'agentBusAddresses', id, { displayAlias: alias, updatedAt: nowIso() });
        adminAudit(ctx, 'agent_messaging.alias', { address_id: id, alias });
        return json({ address: { ...publicAddress(next), alias } });
      },
    });
  }
  async enabled(addressId: string, enabled: boolean) {
    const id = normalizeUuid(addressId, 'address_id');
    if (id === SERVER_ADDRESS_ID)
      throw new ConflictError('Server is a reserved publisher', 'agent_messaging_server_identity_readonly');
    return mutateOwnerState(this.runtime, {
      kind: 'messaging.admin.address_enabled',
      payload: { id, enabled },
      prepare(ctx) {
        const address = ctx.snapshot.addresses.get(id);
        if (!address || address.archivedAt)
          throw new NotFoundError('Agent address not found', 'agent_messaging_address_not_found');
        const now = nowIso();
        let result = { canceled: 0, ambiguous: 0 };
        if (enabled) {
          requireOwnedMessaging(ctx.snapshot);
          const host = ctx.snapshot.hosts.get(address.hostId);
          if (
            !host ||
            !messagingHostEligible(host) ||
            !activeHostEngines(host.engines, ownedEngineState(ctx.snapshot)).includes(
              address.engine as Engine,
            )
          )
            throw new ConflictError(
              'Agent Messaging requires an eligible active host',
              'agent_messaging_host_ineligible',
            );
          stageUpdate(ctx, 'agentBusAddresses', id, {
            enabled: 1,
            readiness: address.currentSessionId
              ? address.readiness
              : address.lastUpstreamSessionId
                ? 'resumable'
                : 'offline',
            updatedAt: now,
          });
        } else {
          result = suspendOwnedMessaging(ctx, address.hostId, 'address_disabled', undefined, now, id);
          stageUpdate(ctx, 'agentBusAddresses', id, { enabled: 0 });
        }
        adminAudit(ctx, 'agent_messaging.address_enabled', { address_id: id, enabled, ...result });
        return { address_id: id, enabled, canceled: result.canceled, ambiguous: result.ambiguous };
      },
    });
  }
  conversations(options: { status?: string; limit?: number }) {
    const snapshot = this.runtime.state.snapshot(),
      limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    return {
      conversations: snapshot
        .table('agentBusConversations')
        .all()
        .filter((row) => !options.status || row.status === options.status)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
        .slice(0, limit)
        .map((row) => ({
          ...conversationMetadata(row),
          address_a: publicAddress(snapshot.addresses.get(row.addressAId)!),
          address_b: publicAddress(snapshot.addresses.get(row.addressBId)!),
        })),
    };
  }
  async redrive(messageId: string) {
    const id = normalizeUuid(messageId, 'message_id');
    return mutateOwnerState(this.runtime, {
      kind: 'messaging.admin.redrive',
      payload: { id },
      authorize: requireOwnedMessaging,
      prepare: async (ctx) => {
        const [cold] = await this.core.db
          .select()
          .from(agentBusMessages)
          .where(eq(agentBusMessages.id, id))
          .limit(1);
        const original = cold ? { ...cold, ...ctx.snapshot.messages.get(id) } : null;
        if (!original) throw new NotFoundError('Message not found', 'agent_messaging_message_not_found');
        if (
          ['digest', 'presence_notice', 'schedule'].includes(original.kind) ||
          !['dead', 'ambiguous'].includes(original.status)
        )
          throw new ConflictError(
            'Message cannot be redriven; inspect its original execution',
            'agent_messaging_redrive_not_allowed',
          );
        const conversation = ctx.snapshot.table('agentBusConversations').get(original.conversationId);
        if (!conversation || conversation.status !== 'open')
          throw new ConflictError('Conversation is canceled', 'agent_messaging_conversation_canceled');
        ownedAddress(ctx.snapshot, original.targetAddressId);
        const now = nowIso(),
          redriveId = randomUUID(),
          { dispatchOrder: _, ...input } = original;
        const message = stageQueuedMessage(ctx, {
          ...input,
          id: redriveId,
          sequence: conversation.nextSequence,
          redriveOfMessageId: id,
          clientMessageId: randomUUID(),
          status: 'queued',
          executionContractVersion:
            original.workKind || ['request', 'task'].includes(original.kind)
              ? 2
              : original.executionContractVersion,
          workKind: original.workKind ?? (['request', 'task'].includes(original.kind) ? original.kind : null),
          taskResultStatus: null,
          executionVersion: 1,
          attempts: 0,
          nextAttemptAt: now,
          ownershipMode: 'connection',
          ownerInstanceId: null,
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
        });
        stageUpdate(ctx, 'agentBusConversations', conversation.id, {
          nextSequence: conversation.nextSequence + 1,
          lastActivityAt: now,
          updatedAt: now,
        });
        adminAudit(ctx, 'agent_messaging.redrive', { message_id: redriveId, redrive_of: id });
        return () => json({ message: messageMetadata(message()), redrive_of_message_id: id });
      },
    });
  }
}
