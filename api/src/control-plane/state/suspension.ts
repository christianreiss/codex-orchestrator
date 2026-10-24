import { persistAuditLog } from '../../services/audit-log.js';
import { recordMessagingRowChange } from './messaging-totals.js';
import { eq } from 'drizzle-orm';
import {
  agentBusAddresses,
  agentBusConferenceMembers,
  agentBusConferences,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentNameLeases,
  agentSessions,
} from '../../db/schema.js';
import { NotFoundError } from '../../http/errors.js';
import { CANCELABLE_MESSAGE_STATUSES } from '../../services/agent-messaging/constants.js';
import { AGENT_NAME_COOLDOWN_SECONDS } from '../../services/agent-messaging/names.js';
import { isoOffsetSeconds } from '../../util/timestamp.js';
import type { Engine } from '../../util/engine.js';
import type { OwnerMutationContext } from './runtime.js';

/** Compose security/engine/host transitions into the caller's single command. */
export function suspendOwnedMessaging(
  ctx: OwnerMutationContext,
  hostId: number,
  reason:
    | 'host_inactive'
    | 'host_auth_rotated'
    | 'engine_disabled'
    | 'messaging_disabled'
    | 'address_disabled',
  engines?: readonly Engine[],
  now = new Date().toISOString(),
  onlyAddressId?: string,
): { canceled: number; ambiguous: number; conversations: number; relays: number; bindings: number } {
  if (!ctx.draft.table('hosts').has(hostId)) throw new NotFoundError('Host not found', 'host_not_found');
  const addresses = ctx.draft
    .table('agentBusAddresses')
    .by('hostId', hostId)
    .filter(
      (row) =>
        (!engines?.length || engines.includes(row.engine as Engine)) &&
        (!onlyAddressId || row.id === onlyAddressId),
    );
  const addressIds = new Set(addresses.map((row) => row.id));
  const cancelable = new Set<string>(CANCELABLE_MESSAGE_STATUSES);
  let canceled = 0,
    ambiguous = 0,
    conversations = 0,
    relays = 0;
  for (const row of ctx.draft.table('agentBusMessages').all()) {
    if (!addressIds.has(row.senderAddressId) && !addressIds.has(row.targetAddressId)) continue;
    const offered = ['leased', 'accepted', 'reboot_hold'].includes(row.status);
    if (cancelable.has(row.status) || offered) {
      const patch = {
        status: offered ? 'ambiguous' : 'canceled',
        cancelRequestedAt: now,
        canceledAt: now,
        leaseUntil: null,
        updatedAt: now,
        lastErrorCode: reason + (offered ? '_after_offer' : ''),
        ...(offered
          ? { ambiguousAt: now }
          : { leaseOwner: null, claimId: null, relayGeneration: null, ownerInstanceId: null }),
      };
      recordMessagingRowChange(ctx.draft, 'agentBusMessages', row, { ...row, ...patch });
      ctx.draft.upsert('agentBusMessages', { ...row, ...patch });
      ctx.write(async (tx) => tx.update(agentBusMessages).set(patch).where(eq(agentBusMessages.id, row.id)));
      if (offered) ambiguous++;
      else canceled++;
    }
  }
  for (const row of ctx.draft.table('agentBusConversations').all()) {
    if (row.status !== 'open' || (!addressIds.has(row.addressAId) && !addressIds.has(row.addressBId)))
      continue;
    const patch = {
      status: 'canceled',
      canceledBy: `system:${reason}`,
      cancelReason:
        reason === 'engine_disabled'
          ? 'Agent engine disabled for host'
          : 'Host is no longer eligible for Agent Messaging',
      canceledAt: now,
      updatedAt: now,
    };
    ctx.draft.upsert('agentBusConversations', { ...row, ...patch });
    ctx.write(async (tx) =>
      tx.update(agentBusConversations).set(patch).where(eq(agentBusConversations.id, row.id)),
    );
    conversations++;
  }
  for (const row of ctx.draft.table('agentBusConferences').all()) {
    if (row.status === 'adjourned' || !addressIds.has(row.ownerAddressId)) continue;
    const patch = {
      status: 'adjourned',
      adjournReason:
        reason === 'engine_disabled'
          ? 'Agent engine disabled for host'
          : 'Host is no longer eligible for Agent Messaging',
      adjournedAt: now,
      pin: null,
      pinExpiresAt: null,
      updatedAt: now,
    };
    ctx.draft.upsert('agentBusConferences', { ...row, ...patch });
    ctx.write(async (tx) =>
      tx.update(agentBusConferences).set(patch).where(eq(agentBusConferences.id, row.id)),
    );
  }
  for (const row of ctx.draft.table('agentBusConferenceMembers').all()) {
    if (row.state === 'left' || !addressIds.has(row.addressId)) continue;
    const patch = {
      state: 'left',
      leftAt: now,
      dispatchMessageId: null,
      dispatchDeadlineAt: null,
      updatedAt: now,
    };
    ctx.draft.upsert('agentBusConferenceMembers', { ...row, ...patch });
    ctx.write(async (tx) =>
      tx.update(agentBusConferenceMembers).set(patch).where(eq(agentBusConferenceMembers.id, row.id)),
    );
  }
  for (const row of addresses) {
    const patch = {
      currentSessionId: null,
      readiness: 'disabled',
      receiveHeartbeatAt: null,
      bindingGeneration: row.bindingGeneration + 1,
      updatedAt: now,
    };
    ctx.draft.upsert('agentBusAddresses', { ...row, ...patch });
    ctx.write(async (tx) => tx.update(agentBusAddresses).set(patch).where(eq(agentBusAddresses.id, row.id)));
  }
  for (const row of ctx.draft.table('agentSessions').all()) {
    if (!row.agentBusAddressId || !addressIds.has(row.agentBusAddressId)) continue;
    const patch = {
      adapterProtocol: null,
      adapterCapabilities: null,
      receiveHeartbeatAt: null,
      bindingGeneration: row.bindingGeneration + 1,
      updatedAt: now,
    };
    ctx.draft.upsert('agentSessions', { ...row, ...patch });
    ctx.write(async (tx) => tx.update(agentSessions).set(patch).where(eq(agentSessions.id, row.id)));
  }
  if (!engines?.length && !onlyAddressId)
    for (const row of ctx.draft.table('agentBusRelays').by('hostId', hostId)) {
      if (row.status !== 'active') continue;
      const patch = {
        status: 'revoked',
        tokenHash: null,
        tokenExpiresAt: null,
        stopRequestedAt: now,
        updatedAt: now,
      };
      ctx.draft.upsert('agentBusRelays', { ...row, ...patch });
      ctx.write(async (tx) => tx.update(agentBusRelays).set(patch).where(eq(agentBusRelays.id, row.id)));
      relays++;
    }
  for (const address of addresses) {
    if (!address.currentSessionId) continue;
    const session = ctx.draft.table('agentSessions').get(address.currentSessionId);
    for (const lease of ctx.draft.table('agentNameLeases').by('sessionId', address.currentSessionId)) {
      if (lease.endedAt !== null) continue;
      const endedAt = session?.endedAt ?? now;
      const patch = {
        endedAt,
        cooldownUntil: isoOffsetSeconds(AGENT_NAME_COOLDOWN_SECONDS, new Date(endedAt)),
      };
      ctx.draft.upsert('agentNameLeases', { ...lease, ...patch });
      ctx.write(async (tx) => tx.update(agentNameLeases).set(patch).where(eq(agentNameLeases.id, lease.id)));
    }
  }
  const result = { canceled, ambiguous, conversations, relays, bindings: addresses.length };
  ctx.write(async (tx) =>
    persistAuditLog(tx, {
      hostId,
      action: 'messaging.runtime.suspended',
      details: JSON.stringify({ reason, engines: engines ?? null, ...result }),
      createdAt: now,
    }),
  );
  return result;
}
