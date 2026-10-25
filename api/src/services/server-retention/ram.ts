import type { OwnerStateSnapshot } from '../../control-plane/state/store.js';
import type { ConnectionPresence } from '../../control-plane/presence.js';
import type { RetentionFamily, RetentionClockSnapshot } from './deadlines.js';
import { RETENTION_CLOCKS } from './deadlines.js';
import { OWNED_TABLE_NAMES, stateTableName, type OwnedTableName } from '../../control-plane/state/catalog.js';

const busPending = new Set(['queued', 'leased', 'accepted', 'reboot_hold', 'batched', 'ambiguous']);
const portalPending = new Set(['queued', 'leased', 'accepted', 'reboot_hold', 'ambiguous']);
const liveWatchdogs = new Set(['watching', 'recovering', 'capacity_wait']);
const liveReboots = new Set(['prepared', 'armed', 'resuming']);
const tablesBySqlName = new Map(OWNED_TABLE_NAMES.map((name) => [stateTableName(name), name]));

/** A derived decision from current owner facts, not a second source of truth. */
export function retentionFacts(state: OwnerStateSnapshot, cutoff: string, presence?: ConnectionPresence) {
  const protectedAddresses = new Set<string>(),
    activeAddresses = new Set<string>(),
    protectedSessions = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) protectedAddresses.add(value);
  };
  for (const job of state.table('agentSchedules').all()) if (!job.deletedAt) add(job.targetAddressId);
  for (const job of state.table('agentWatchdogs').all())
    if (liveWatchdogs.has(job.status)) add(job.targetAddressId);
  for (const row of state.table('agentRebootHandoffs').all())
    if (liveReboots.has(row.status)) {
      add(row.addressId);
      if (row.oldSessionId) protectedSessions.add(row.oldSessionId);
      if (row.newSessionId) protectedSessions.add(row.newSessionId);
    }
  for (const row of state.table('agentRoleProposals').all())
    if (!['applied', 'rejected', 'withdrawn', 'superseded'].includes(row.status)) {
      add(row.authorAddressId);
      add(row.reviewerAddressId);
    }
  for (const row of state.messages.all())
    if (busPending.has(row.status) || row.taskResultStatus === 'unknown') {
      add(row.senderAddressId);
      add(row.targetAddressId);
    }
  for (const row of state.addresses.all()) if (row.lastSeenAt > cutoff) activeAddresses.add(row.id);
  for (const session of state.sessions.all()) {
    if (
      session.agentBusAddressId &&
      (!session.endedAt ||
        session.heartbeatAt > cutoff ||
        presence?.hasSession(session.id, session.bindingGeneration))
    )
      activeAddresses.add(session.agentBusAddressId);
    if (session.agentBusAddressId && protectedAddresses.has(session.agentBusAddressId))
      protectedSessions.add(session.id);
    if (presence?.hasSession(session.id, session.bindingGeneration)) protectedSessions.add(session.id);
  }
  for (const row of state.table('agentMessages').all())
    if (portalPending.has(row.status)) protectedSessions.add(row.sessionId);
  for (const row of state.claims.all())
    if (['active', 'waiting', 'uncertain'].includes(row.state)) protectedSessions.add(row.sessionId);
  const protectedScopes = new Set<string>();
  for (const member of state.table('agentScopeMembers').all()) {
    const session = state.sessions.get(member.sessionId);
    if (
      session &&
      (!session.endedAt ||
        protectedSessions.has(session.id) ||
        session.heartbeatAt > cutoff ||
        (session.agentBusAddressId &&
          (activeAddresses.has(session.agentBusAddressId) ||
            protectedAddresses.has(session.agentBusAddressId))))
    )
      protectedScopes.add(member.scopeId);
  }
  const blockedAddress = (id: string | null) =>
    !!id && (protectedAddresses.has(id) || activeAddresses.has(id));
  const protectedRooms = new Set<string>(protectedScopes);
  for (const row of state.table('agentRoomEvents').all())
    if (row.createdAt > cutoff) protectedRooms.add(row.roomId);
  for (const member of state.table('agentBusConferenceMembers').all())
    if (blockedAddress(member.addressId)) protectedRooms.add(member.conferenceId);
  for (const group of state.table('agentBusGroups').all())
    if (
      state
        .table('agentBusSubscriptions')
        .all()
        .some((sub) => sub.topic === `group:${group.slug}` && blockedAddress(sub.subscriberAddressId))
    )
      protectedRooms.add(group.id);
  for (const delivery of state.table('agentRoomDeliveries').all()) {
    const message = delivery.messageId ? state.messages.get(delivery.messageId) : undefined;
    if (message && (busPending.has(message.status) || message.taskResultStatus === 'unknown')) {
      const event = state.table('agentRoomEvents').get(delivery.eventId);
      if (event) protectedRooms.add(event.roomId);
    }
  }
  return {
    protectedAddresses,
    activeAddresses,
    protectedSessions,
    protectedScopes,
    protectedRooms,
    blockedAddress,
  };
}

export function scopeHistoryCandidates(
  state: OwnerStateSnapshot,
  cutoff: string,
  presence?: ConnectionPresence,
) {
  const blocked = retentionFacts(state, cutoff, presence).protectedScopes;
  return state
    .table('agentScopeEvents')
    .all()
    .filter((row) => row.dispatched === 1 && row.createdAt <= cutoff && !blocked.has(row.scopeId))
    .slice(0, 100);
}

export function ownerHistoryCandidates(
  state: OwnerStateSnapshot,
  cutoff: string,
  now: string,
  presence?: ConnectionPresence,
  batch = true,
) {
  const limit = batch ? 100 : Infinity;
  const facts = retentionFacts(state, cutoff, presence);
  const portal = () =>
    state.sessions
      .all()
      .filter(
        (s) =>
          !!s.endedAt &&
          !!s.expiresAt &&
          s.expiresAt <= now &&
          !facts.protectedSessions.has(s.id) &&
          !state
            .table('agentChatNotices')
            .by('sessionId', s.id)
            .some((n) => !n.resolvedAt && n.createdAt > cutoff),
      )
      .sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!))
      .slice(0, limit);
  const relays = () =>
    state
      .table('agentBusRelays')
      .all()
      .filter(
        (r) =>
          r.heartbeatAt <= cutoff &&
          (!r.tokenExpiresAt || r.tokenExpiresAt <= now) &&
          !presence?.hasRelay(r.id) &&
          !state.messages
            .all()
            .some(
              (m) =>
                m.leaseOwner?.startsWith(`relay:${r.id}:`) &&
                ['leased', 'accepted', 'reboot_hold'].includes(m.status),
            ),
      )
      .slice(0, limit);
  const conversations = () =>
    state
      .table('agentBusConversations')
      .all()
      .filter(
        (c) =>
          c.lastActivityAt <= cutoff &&
          !facts.blockedAddress(c.addressAId) &&
          !facts.blockedAddress(c.addressBId) &&
          !state
            .table('advisorSessions')
            .all()
            .some((v) => v.conversationId === c.id && v.status === 'open') &&
          !state
            .table('agentBusConferenceMembers')
            .all()
            .some(
              (m) =>
                m.conversationId === c.id &&
                state.table('agentBusConferences').get(m.conferenceId)?.status !== 'adjourned',
            ),
      )
      .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt))
      .slice(0, batch ? 1 : Infinity);
  const daemons = () =>
    state
      .table('hostDaemonSessions')
      .all()
      .filter(
        (d) =>
          d.lastActivityAt <= cutoff &&
          ['closed', 'failed'].includes(d.status) &&
          !facts.blockedAddress(d.addressId) &&
          !state
            .table('hostDaemonOperations')
            .by('sessionId', d.id)
            .some((o) => ['queued', 'offered', 'accepted', 'running', 'unknown'].includes(o.status)),
      )
      .slice(0, limit);
  const chatty = () =>
    state
      .table('chattySessions')
      .all()
      .filter(
        (s) =>
          s.updatedAt <= cutoff &&
          (s.eventCursor > 0 || state.table('chattyRuns').by('userId', s.userId).length > 0) &&
          !state
            .table('chattyRuns')
            .by('userId', s.userId)
            .some((r) => r.updatedAt > cutoff || ['queued', 'running', 'unknown'].includes(r.status)) &&
          !state
            .table('chattyActions')
            .by('userId', s.userId)
            .some((a) => ['executing', 'unknown'].includes(a.status)),
      )
      .slice(0, limit);
  const addresses = () =>
    state.addresses
      .all()
      .filter(
        (a) =>
          a.lastSeenAt <= cutoff &&
          !facts.blockedAddress(a.id) &&
          !state.hosts.get(a.hostId)?.internalRole &&
          !state.sessions.by('agentBusAddressId', a.id).length &&
          !state
            .table('agentBusConversations')
            .all()
            .some((c) => c.addressAId === a.id || c.addressBId === a.id) &&
          !state
            .table('agentBusConferences')
            .all()
            .some((c) => c.ownerAddressId === a.id) &&
          !state.table('agentBusConferenceMembers').by('addressId', a.id).length &&
          !state.table('hostDaemonSessions').by('addressId', a.id).length,
      )
      .slice(0, limit);
  return { facts, portal, relays, conversations, daemons, chatty, addresses };
}
export function hasOwnerHistoryWork(
  state: OwnerStateSnapshot,
  family: RetentionFamily,
  cutoff: string,
  now: string,
  presence?: ConnectionPresence,
): boolean {
  if (family === 'credentials')
    return (
      state
        .table('mcpSessionTokens')
        .all()
        .some((r) => r.expiresAt <= now) ||
      state.adminSessions.all().some((r) => r.expiresAt <= now) ||
      state
        .table('providerAccountSessions')
        .all()
        .some((r) => r.ownershipMode === 'timed' && r.expiresAt <= now)
    );
  const candidates = ownerHistoryCandidates(state, cutoff, now, presence);
  if (
    family === 'portal' ||
    family === 'relays' ||
    family === 'conversations' ||
    family === 'daemons' ||
    family === 'chatty' ||
    family === 'addresses'
  )
    return (
      candidates[family]().length > 0 ||
      (family === 'addresses' &&
        state
          .table('agentBusPublications')
          .all()
          .some((r) => r.createdAt <= cutoff))
    );
  if (family === 'rooms')
    return (
      state
        .table('agentRoomEvents')
        .all()
        .some((e) => e.createdAt <= cutoff && !candidates.facts.protectedRooms.has(e.roomId)) ||
      scopeHistoryCandidates(state, cutoff, presence).length > 0 ||
      state
        .table('agentRoomOperations')
        .all()
        .some((r) => r.createdAt <= cutoff) ||
      state
        .table('agentBusConferences')
        .all()
        .some(
          (c) =>
            c.status === 'adjourned' &&
            (c.adjournedAt ?? c.createdAt) <= cutoff &&
            !candidates.facts.blockedAddress(c.ownerAddressId) &&
            !candidates.facts.protectedRooms.has(c.id) &&
            !state.table('agentRoomEvents').by('roomId', c.id).length,
        ) ||
      state
        .table('agentRoomReads')
        .all()
        .some((r) => r.readAt <= cutoff && !state.table('agentRoomEvents').by('roomId', r.roomId).length) ||
      state
        .table('agentChatAttachments')
        .all()
        .some(
          (a) =>
            a.status !== 'retired' &&
            a.updatedAt <= cutoff &&
            (state.table('agentBusGroups').has(a.sessionId) || state.table('agentScopes').has(a.sessionId)) &&
            !state.table('agentRoomEvents').by('roomId', a.sessionId).length,
        )
    );
  return true;
}

/** Recompute known timestamps from owner state after a due operation, without SQL discovery. */
export function readOwnerRetentionClock(
  state: OwnerStateSnapshot,
  family: Exclude<RetentionFamily, 'turns' | 'auditlogs' | 'adminaudit' | 'quota' | 'receipts'>,
  now: number,
  hours: number,
): RetentionClockSnapshot {
  let past = false,
    next: number | null = null;
  for (const clock of RETENTION_CLOCKS[family]) {
    const name = tablesBySqlName.get(clock.table) as OwnedTableName;
    if (!name) continue; // Cold bodies/events are represented by their owner heads.
    const field = clock.column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const delay = clock.delay >= 86400000 ? hours * 3600000 + (clock.delay - 86400000) : clock.delay;
    for (const raw of state.table(name).all()) {
      const row = raw as unknown as Record<string, unknown>;
      if (name === 'providerAccountSessions' && row.ownershipMode !== 'timed') continue;
      const value = row[field];
      if (typeof value !== 'string') continue;
      const due = Date.parse(value) + delay;
      if (!Number.isFinite(due)) continue;
      if (due <= now) past = true;
      else next = next === null ? due : Math.min(next, due);
    }
  }
  if (past) {
    for (const due of [
      ...state.sessions.all().map((s) => Date.parse(s.heartbeatAt) + hours * 3600000),
      ...state.addresses.all().map((a) => Date.parse(a.lastSeenAt) + hours * 3600000),
    ])
      if (Number.isFinite(due) && due > now) next = next === null ? due : Math.min(next, due);
  }
  return { past, next };
}
