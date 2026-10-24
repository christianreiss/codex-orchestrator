import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import type { OwnerWorkObligation } from './owner-worker.js';
import type { MessagingMaintenanceFacts } from './owner-maintenance.js';
import { INSECURE_FLEET_WINDOW_KEY } from '../services/insecure-fleet-window.js';
import {
  insecureWindowActiveAt,
  PENDING_APPROVAL_TTL_MS,
  PENDING_HEARTBEAT_TTL_MS,
} from '../services/insecure-window.js';

function obligation(
  key: string,
  at: string | null | undefined,
  revision: string,
  offset = 0,
): OwnerWorkObligation[] {
  const dueAt = at ? Date.parse(at) + offset : NaN;
  return Number.isFinite(dueAt) ? [{ key, dueAt, revision }] : [];
}
export const MESSAGING_MAINTENANCE_TABLES = [
  'agentBusMessages',
  'agentBusAddresses',
  'agentSessions',
  'agentBusRelays',
  'agentRebootHandoffs',
  'agentBusConferences',
  'agentBusConferenceMembers',
  'agentRoomDeliveries',
  'agentRoomEvents',
] as const;

/** Matches every branch of AgentMessagingService.maintenance; no queue polling. */
export function messagingMaintenanceObligations(
  snapshot: OwnerStateSnapshot,
  facts: MessagingMaintenanceFacts,
): OwnerWorkObligation[] {
  const work: OwnerWorkObligation[] = [];
  for (const message of snapshot.messages.all()) {
    if (
      ['queued', 'batched'].includes(message.status) ||
      (message.status === 'leased' && message.ownershipMode !== 'connection')
    )
      work.push(...obligation(`message:expire:${message.id}`, message.expiresAt, message.updatedAt));
    if (message.ownershipMode !== 'connection' && message.status === 'leased')
      work.push(...obligation(`message:lease:${message.id}`, message.leaseUntil, message.updatedAt));
    if (message.ownershipMode !== 'connection' && message.status === 'accepted')
      work.push(
        ...obligation(
          `message:accepted:${message.id}`,
          message.leaseUntil ?? message.updatedAt,
          message.updatedAt,
          message.leaseUntil ? 0 : 86_400_000,
        ),
      );
    if (
      message.kind === 'presence_notice' &&
      ['queued', 'leased', 'accepted', 'batched'].includes(message.status)
    ) {
      const session = message.targetSessionId ? snapshot.sessions.get(message.targetSessionId) : undefined;
      const address = snapshot.addresses.get(message.targetAddressId);
      if (!session || session.endedAt || address?.currentSessionId !== session.id)
        work.push({ key: `notice:${message.id}`, dueAt: 0, revision: message.updatedAt });
    }
  }
  for (const address of snapshot.addresses.all()) {
    if (!address.currentSessionId) continue;
    const session = snapshot.sessions.get(address.currentSessionId);
    if (!session) continue;
    // Authentication expiry revokes authority, not the resumable native identity.
    if (session.endedAt)
      work.push({ key: `binding:${address.id}`, dueAt: 0, revision: `${session.id}:${session.endedAt}` });
  }
  for (const handoff of snapshot.table('agentRebootHandoffs').all()) {
    if (['prepared', 'armed'].includes(handoff.status))
      work.push(...obligation(`reboot:${handoff.id}`, handoff.expiresAt, handoff.updatedAt));
  }
  const members = snapshot.table('agentBusConferenceMembers').all();
  for (const conference of snapshot.table('agentBusConferences').all()) {
    if (conference.pin !== null)
      work.push(...obligation(`pin:${conference.id}`, conference.pinExpiresAt, conference.updatedAt));
    if (conference.status !== 'adjourned')
      work.push(...obligation(`conference:${conference.id}`, conference.deadlineAt, conference.updatedAt));
    if (
      conference.status === 'adjourning' &&
      conference.ownerAdminId === null &&
      !members.some((member) => member.conferenceId === conference.id && member.state === 'dispatched') &&
      !facts.conferenceHasPendingDeliveries(conference.id)
    ) {
      work.push({ key: `conference:drain:${conference.id}`, dueAt: 0, revision: conference.updatedAt });
    }
  }
  for (const member of members) {
    if (member.state === 'dispatched')
      work.push(...obligation(`dispatch:${member.id}`, member.dispatchDeadlineAt, member.updatedAt));
  }
  return work;
}

export const INSECURE_MAINTENANCE_TABLES = ['versions', 'hosts', 'insecureAuthRequests'] as const;
export function insecureMaintenanceObligations(
  snapshot: OwnerStateSnapshot,
  now: number,
  observed: <T extends { id: number; updatedAt: string }>(request: T) => T = (request) => request,
): OwnerWorkObligation[] {
  const fleet = snapshot.setting(INSECURE_FLEET_WINDOW_KEY);
  const work = obligation('fleet-window', fleet, fleet ?? '');
  for (const stored of snapshot.table('insecureAuthRequests').all()) {
    const request = observed(stored);
    if (request.status !== 'pending') continue;
    const host = snapshot.hosts.get(request.hostId);
    if (!host || host.secure === 1 || insecureWindowActiveAt(host, now)) {
      work.push({ key: `approval:superseded:${request.id}`, dueAt: 0, revision: request.updatedAt });
      continue;
    }
    work.push(
      ...obligation(
        `approval:ttl:${request.id}`,
        request.requestedAt,
        request.updatedAt,
        PENDING_APPROVAL_TTL_MS,
      ),
    );
    work.push(
      ...obligation(
        `approval:caller:${request.id}`,
        request.updatedAt || request.requestedAt,
        request.updatedAt,
        PENDING_HEARTBEAT_TTL_MS,
      ),
    );
  }
  return work;
}

export function transferExpiryObligations(snapshot: OwnerStateSnapshot): OwnerWorkObligation[] {
  return snapshot
    .table('agentTransfers')
    .all()
    .flatMap((row) =>
      ['uploading', 'live'].includes(row.status)
        ? obligation(row.id, row.expiresAt, row.updatedAt)
        : ['expired', 'deleted'].includes(row.status) && !row.purgedAt
          ? obligation(row.id, row.updatedAt, `${row.status}:${row.updatedAt}:unpurged`)
          : [],
    );
}
export function authRetentionObligations(snapshot: OwnerStateSnapshot): OwnerWorkObligation[] {
  const accounts = snapshot.accounts.all();
  const protectedIds = new Set([
    ...snapshot
      .table('authCanonicalHeads')
      .all()
      .map((row) => row.payloadId),
    ...accounts.map((row) => row.payloadId),
  ]);
  const removedAccounts = new Set(accounts.filter((row) => row.state === 'removed').map((row) => row.id));
  return snapshot
    .table('authPayloads')
    .all()
    .flatMap((row) => {
      if (
        protectedIds.has(row.id) ||
        removedAccounts.has(row.accountId ?? -1) ||
        !row.supersededAt ||
        !row.purgeAfter
      )
        return [];
      const at = Math.max(Date.parse(row.supersededAt), Date.parse(row.purgeAfter)) + 1;
      return Number.isFinite(at)
        ? [{ key: String(row.id), dueAt: at, revision: `${row.supersededAt}:${row.purgeAfter}` }]
        : [];
    });
}
