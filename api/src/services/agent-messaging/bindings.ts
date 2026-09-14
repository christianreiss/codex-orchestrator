/**
 * Binding lifecycle outside a live session: suspending a host's runtime,
 * releasing its address bindings, and reaping the ones nobody released.
 *
 * These run from host management and the maintenance tick rather than from a
 * request, so they take a transaction handle and never touch the service.
 */

import { and, count, eq, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import {
  agentBusAddresses,
  agentBusConferenceMembers,
  agentBusConferences,
  agentBusConversations,
  agentBusMessages,
  agentBusRelays,
  agentSessions,
  hosts,
} from '../../db/schema.js';
import { NotFoundError } from '../../http/errors.js';
import { type Engine } from '../../util/engine.js';
import { nowIso } from '../../util/timestamp.js';
import { CANCELABLE_MESSAGE_STATUSES } from './constants.js';
import type { AgentMessagingDb } from './types.js';

/**
 * Apply the destructive half of an eligibility transition inside the caller's
 * transaction. Host security, engine, uninstall, and pruning code use this
 * primitive so their host-row mutation cannot commit while bus cleanup fails.
 */
export async function suspendAgentMessagingRuntimeLocked(
  db: AgentMessagingDb,
  hostId: number,
  reason: 'host_inactive' | 'host_auth_rotated' | 'engine_disabled',
  engines?: Engine[],
): Promise<{ canceled: number; ambiguous: number; conversations: number; relays: number; bindings: number }> {
  const now = nowIso();
  const hostRows = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1).for('update');
  if (!hostRows[0]) throw new NotFoundError('Host not found', 'host_not_found');
  const addressPredicate = engines?.length
    ? and(eq(agentBusAddresses.hostId, hostId), inArray(agentBusAddresses.engine, engines))
    : eq(agentBusAddresses.hostId, hostId);
  const addressRows = await db
    .select({ id: agentBusAddresses.id })
    .from(agentBusAddresses)
    .where(addressPredicate)
    .for('update');
  const addressIds = addressRows.map((row) => row.id);
  let canceled = 0;
  let ambiguous = 0;
  let conversations = 0;
  if (addressIds.length > 0) {
    const messageScope = or(
      inArray(agentBusMessages.senderAddressId, addressIds),
      inArray(agentBusMessages.targetAddressId, addressIds),
    );
    const conversationScope = or(
      inArray(agentBusConversations.addressAId, addressIds),
      inArray(agentBusConversations.addressBId, addressIds),
    );
    const [pending, uncertain, open] = await Promise.all([
      db.select({ value: count() }).from(agentBusMessages).where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), messageScope)),
      db.select({ value: count() }).from(agentBusMessages).where(and(eq(agentBusMessages.status, 'accepted'), messageScope)),
      db.select({ value: count() }).from(agentBusConversations).where(and(eq(agentBusConversations.status, 'open'), conversationScope)),
    ]);
    canceled = Number(pending[0]?.value ?? 0);
    ambiguous = Number(uncertain[0]?.value ?? 0);
    conversations = Number(open[0]?.value ?? 0);
    await db
      .update(agentBusMessages)
      .set({ status: 'canceled', cancelRequestedAt: now, canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(inArray(agentBusMessages.status, [...CANCELABLE_MESSAGE_STATUSES]), messageScope));
    await db
      .update(agentBusMessages)
      .set({ status: 'ambiguous', ambiguousAt: now, lastErrorCode: `${reason}_after_accept`, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(agentBusMessages.status, 'accepted'), messageScope));
    await db
      .update(agentBusConversations)
      .set({
        status: 'canceled',
        canceledBy: `system:${reason}`,
        cancelReason: reason === 'engine_disabled'
          ? 'Agent engine disabled for host'
          : 'Host is no longer eligible for Agent Messaging',
        canceledAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentBusConversations.status, 'open'), conversationScope));
    // Conferences outlive individual conversations, so cancelling the spokes is
    // not enough: a room whose chair has just been made ineligible would stay
    // `open` forever, holding its PIN and admitting joiners to a meeting nobody
    // can run. Close the rooms these addresses chair, and seat-release them from
    // any room they merely attend.
    await db
      .update(agentBusConferences)
      .set({
        status: 'adjourned',
        adjournReason: reason === 'engine_disabled' ? 'Agent engine disabled for host' : 'Host is no longer eligible for Agent Messaging',
        adjournedAt: now,
        pin: null,
        pinExpiresAt: null,
        updatedAt: now,
      })
      .where(and(ne(agentBusConferences.status, 'adjourned'), inArray(agentBusConferences.ownerAddressId, addressIds)));
    await db
      .update(agentBusConferenceMembers)
      .set({ state: 'left', leftAt: now, dispatchMessageId: null, dispatchDeadlineAt: null, updatedAt: now })
      .where(and(ne(agentBusConferenceMembers.state, 'left'), inArray(agentBusConferenceMembers.addressId, addressIds)));
    await db
      .update(agentBusAddresses)
      .set({
        currentSessionId: null,
        readiness: 'disabled',
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentBusAddresses.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentBusAddresses.id, addressIds));
    await db
      .update(agentSessions)
      .set({
        adapterProtocol: null,
        adapterCapabilities: null,
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentSessions.agentBusAddressId, addressIds));
  }
  const relayRows = engines?.length
    ? [{ value: 0 }]
    : await db.select({ value: count() }).from(agentBusRelays).where(and(eq(agentBusRelays.hostId, hostId), eq(agentBusRelays.status, 'active')));
  if (!engines?.length) {
    await db
      .update(agentBusRelays)
      .set({ status: 'revoked', tokenHash: null, tokenExpiresAt: null, stopRequestedAt: now, updatedAt: now })
      .where(and(eq(agentBusRelays.hostId, hostId), eq(agentBusRelays.status, 'active')));
  }
  return {
    canceled,
    ambiguous,
    conversations,
    relays: Number(relayRows[0]?.value ?? 0),
    bindings: addressIds.length,
  };
}

export async function releaseAgentMessagingBindingsLocked(
  db: AgentMessagingDb,
  sessionIds: string[],
  now = nowIso(),
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = await db
    .select({ address: agentBusAddresses, session: agentSessions })
    .from(agentBusAddresses)
    .innerJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(inArray(agentSessions.id, sessionIds))
    .for('update');
  for (const row of rows) {
    const upstream = row.session.upstreamSessionId ?? row.address.lastUpstreamSessionId;
    await db
      .update(agentBusAddresses)
      .set({
        currentSessionId: null,
        lastUpstreamSessionId: upstream,
        adapterProtocol: null,
        adapterCapabilities: null,
        readiness: upstream ? 'resumable' : 'offline',
        receiveHeartbeatAt: null,
        // Same reason as finishSession: a reaped binding must not leave a live
        // PIN pointing at an address that is no longer on the line.
        callPin: null,
        callPinExpiresAt: null,
        bindingGeneration: row.address.bindingGeneration + 1,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentBusAddresses.id, row.address.id), eq(agentBusAddresses.currentSessionId, row.session.id)));
  }
  const boundSessionIds = rows.map((row) => row.session.id);
  if (boundSessionIds.length > 0) {
    await db
      .update(agentSessions)
      .set({
        adapterProtocol: null,
        adapterCapabilities: null,
        receiveHeartbeatAt: null,
        bindingGeneration: sql`${agentSessions.bindingGeneration} + 1`,
        updatedAt: now,
      })
      .where(inArray(agentSessions.id, boundSessionIds));
  }
  return rows.length;
}

export async function reapExpiredAgentMessagingBindingsLocked(
  db: AgentMessagingDb,
  now = nowIso(),
  scope: { hostId?: number; engine?: Engine; username?: string } = {},
): Promise<number> {
  const predicates = [
    or(isNotNull(agentSessions.endedAt), lte(agentSessions.bridgeExpiresAt, now)),
  ];
  if (scope.hostId != null) predicates.push(eq(agentBusAddresses.hostId, scope.hostId));
  if (scope.engine) predicates.push(eq(agentBusAddresses.engine, scope.engine));
  if (scope.username) predicates.push(eq(agentBusAddresses.username, scope.username));
  const rows = await db
    .select({ sessionId: agentSessions.id })
    .from(agentBusAddresses)
    .innerJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(and(...predicates))
    .for('update');
  return await releaseAgentMessagingBindingsLocked(
    db,
    [...new Set(rows.map((row) => row.sessionId))],
    now,
  );
}
