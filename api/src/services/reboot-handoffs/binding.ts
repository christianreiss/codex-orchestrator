import { and, eq, inArray, lte } from 'drizzle-orm';
import {
  agentRebootHandoffs,
  agentSessions,
  agentBusAddresses,
  agentBusMessages,
  agentMessages,
  hostDaemonPortalBindings,
  hostDaemonSessions,
  hostDaemonOperations,
  type Host,
  type AgentBusAddress,
} from '../../db/schema.js';
import { ForbiddenError } from '../../http/errors.js';
import { nowIso, isoOffsetSeconds } from '../../util/timestamp.js';
import type { AgentMessagingDb, RegisterMessagingSessionInput } from '../agent-messaging/types.js';
import { endLaunchNamesLocked } from '../agent-messaging/names.js';
import { active, fail, noCompetingRecovery, type Handoff } from './policy.js';

// Called INSIDE the normal registration transaction. The old token is fenced
// and the native address is freed before the regular naming/binding path runs.
export async function beginRebootBinding(
  db: AgentMessagingDb,
  host: Host,
  input: RegisterMessagingSessionInput,
): Promise<Handoff | null> {
  if (!input.rebootRequestId) return null;
  const [r] = await db
    .select()
    .from(agentRebootHandoffs)
    .where(eq(agentRebootHandoffs.id, input.rebootRequestId))
    .for('update');
  if (
    !r ||
    r.hostId !== host.id ||
    r.engine !== input.engine ||
    r.username !== input.username ||
    r.cwd !== input.cwd ||
    r.nativeSessionId !== input.upstreamSessionId ||
    !input.rebootBootId ||
    input.rebootBootId === r.bootId
  )
    throw new ForbiddenError('Reboot handoff identity mismatch');
  if (r.newSessionId === input.sessionId && r.resumeBootId === input.rebootBootId) return r;
  if (r.status !== 'armed' || r.expiresAt <= nowIso() || r.newSessionId)
    throw fail('Reboot handoff is consumed, expired or canceled');
  const [old] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, r.oldSessionId))
    .for('update');
  const [address] = await db
    .select()
    .from(agentBusAddresses)
    .where(eq(agentBusAddresses.id, r.addressId))
    .for('update');
  if (
    !old ||
    old.closeRequestedAt ||
    address?.currentSessionId !== old.id ||
    address.enabled !== 1 ||
    address.archivedAt ||
    address.lastUpstreamSessionId !== r.nativeSessionId
  )
    throw fail('Reboot was stopped or native binding changed');
  await noCompetingRecovery(db, r.addressId);
  const [remote] = await db
    .select()
    .from(hostDaemonPortalBindings)
    .where(eq(hostDaemonPortalBindings.portalSessionId, r.oldSessionId));
  if (remote) {
    const [s] = await db
      .select()
      .from(hostDaemonSessions)
      .where(eq(hostDaemonSessions.id, remote.daemonSessionId))
      .for('update');
    if (!s || ['stopping', 'closed'].includes(s.status)) throw fail('Remote session was stopped');
  }
  if (r.busMessageIds.length) {
    const messages = await db
      .select()
      .from(agentBusMessages)
      .where(inArray(agentBusMessages.id, r.busMessageIds))
      .for('update');
    if (
      messages.length !== r.busMessageIds.length ||
      messages.some((m) => m.status !== 'reboot_hold' || m.cancelRequestedAt)
    )
      throw fail('Transferred work was canceled or changed');
  }
  const now = nowIso();
  await db
    .update(agentSessions)
    .set({
      status: 'rebooted',
      endedAt: now,
      bridgeExpiresAt: now,
      expiresAt: isoOffsetSeconds(86400),
      updatedAt: now,
    })
    .where(eq(agentSessions.id, old.id));
  await endLaunchNamesLocked(db, [old.id], now);
  await db
    .update(agentBusAddresses)
    .set({ currentSessionId: null })
    .where(eq(agentBusAddresses.id, r.addressId));
  await db
    .update(agentRebootHandoffs)
    .set({
      status: 'resuming',
      resumeBootId: input.rebootBootId,
      newSessionId: input.sessionId,
      updatedAt: now,
    })
    .where(eq(agentRebootHandoffs.id, r.id));
  return r;
}
export async function completeRebootBinding(
  db: AgentMessagingDb,
  r: Handoff | null,
  sessionId: string,
  address: AgentBusAddress,
) {
  if (!r || r.newSessionId === sessionId) return;
  const now = nowIso();
  if (r.busMessageIds.length)
    await db
      .update(agentBusMessages)
      .set({
        status: 'accepted',
        leaseOwner: `session:${sessionId}`,
        leaseUntil: isoOffsetSeconds(120),
        relayGeneration: null,
        targetBindingGeneration: address.bindingGeneration,
        deliverySessionId: sessionId,
        updatedAt: now,
      })
      .where(and(inArray(agentBusMessages.id, r.busMessageIds), eq(agentBusMessages.status, 'reboot_hold')));
  if (r.portalMessageIds.length) {
    await db
      .update(agentMessages)
      .set({ status: 'accepted', sessionId, updatedAt: now })
      .where(
        and(inArray(agentMessages.messageId, r.portalMessageIds), eq(agentMessages.status, 'reboot_hold')),
      );
    const [old] = await db.select().from(agentSessions).where(eq(agentSessions.id, r.oldSessionId));
    await db
      .update(agentSessions)
      .set({ activeTurnId: old?.activeTurnId, updatedAt: now })
      .where(eq(agentSessions.id, sessionId));
  }
  const [remote] = await db
    .select()
    .from(hostDaemonPortalBindings)
    .where(eq(hostDaemonPortalBindings.portalSessionId, r.oldSessionId));
  if (remote) {
    await db
      .insert(hostDaemonPortalBindings)
      .values({ portalSessionId: sessionId, daemonSessionId: remote.daemonSessionId });
    await db
      .update(hostDaemonSessions)
      .set({ sessionId, status: 'running', lastActivityAt: now })
      .where(eq(hostDaemonSessions.id, remote.daemonSessionId));
  }
  await db
    .update(agentRebootHandoffs)
    .set({ status: 'resumed', activeHostId: null, updatedAt: now })
    .where(eq(agentRebootHandoffs.id, r.id));
}

export async function expireRebootHandoffs(db: AgentMessagingDb, now: string) {
  const rows = await db
    .select()
    .from(agentRebootHandoffs)
    .where(and(inArray(agentRebootHandoffs.status, active), lte(agentRebootHandoffs.expiresAt, now)))
    .for('update');
  for (const r of rows) {
    if (r.busMessageIds.length)
      await db
        .update(agentBusMessages)
        .set({
          status: 'ambiguous',
          lastErrorCode: 'reboot_handoff_expired',
          ambiguousAt: now,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(
          and(inArray(agentBusMessages.id, r.busMessageIds), eq(agentBusMessages.status, 'reboot_hold')),
        );
    if (r.portalMessageIds.length)
      await db
        .update(agentMessages)
        .set({ status: 'dead', lastError: 'Reboot handoff expired without a result', updatedAt: now })
        .where(
          and(inArray(agentMessages.messageId, r.portalMessageIds), eq(agentMessages.status, 'reboot_hold')),
        );
    const [remote] = await db
      .select()
      .from(hostDaemonPortalBindings)
      .where(eq(hostDaemonPortalBindings.portalSessionId, r.oldSessionId));
    if (remote) {
      await db
        .update(hostDaemonOperations)
        .set({ status: 'unknown', updatedAt: now })
        .where(
          and(
            eq(hostDaemonOperations.sessionId, remote.daemonSessionId),
            eq(hostDaemonOperations.status, 'reboot_hold'),
          ),
        );
      await db
        .update(hostDaemonSessions)
        .set({ status: 'waiting', lastActivityAt: now })
        .where(
          and(eq(hostDaemonSessions.id, remote.daemonSessionId), eq(hostDaemonSessions.status, 'running')),
        );
    }
    await db
      .update(agentRebootHandoffs)
      .set({ status: 'expired', activeHostId: null, updatedAt: now })
      .where(eq(agentRebootHandoffs.id, r.id));
  }
}
