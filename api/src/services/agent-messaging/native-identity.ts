import { moveLaunchNameLocked } from './names.js';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { agentBusAddresses, agentSessions, type AgentSession } from '../../db/schema.js';
import { ConflictError } from '../../http/errors.js';
import type { AgentMessagingDb } from './types.js';

/** Bind a reported transcript, never a directory. Caller holds the session lock. */
export async function bindNativeMessagingIdentityLocked(
  db: AgentMessagingDb, session: AgentSession, nativeId: string, now: string,
) {
  const [current] = await db.select().from(agentBusAddresses)
    .where(eq(agentBusAddresses.id, session.agentBusAddressId!)).for('update');
  if (!current || current.currentSessionId !== session.id || current.archivedAt || current.enabled !== 1)
    throw new ConflictError('Address binding changed', 'receiver_binding_changed');
  if (current.lastUpstreamSessionId === nativeId) return current;

  // Picker/--continue launches only learn their real transcript from the native
  // receiver. Reattach that mailbox once proven; never guess from cwd or recency.
  const [known] = await db.select().from(agentBusAddresses).where(and(
    eq(agentBusAddresses.hostId, session.hostId), eq(agentBusAddresses.engine, session.engine),
    eq(agentBusAddresses.username, session.username), eq(agentBusAddresses.lastUpstreamSessionId, nativeId),
    eq(agentBusAddresses.enabled, 1), isNull(agentBusAddresses.archivedAt),
  )).orderBy(desc(agentBusAddresses.lastSeenAt)).limit(1).for('update');
  if (known?.currentSessionId && known.currentSessionId !== session.id)
    throw new ConflictError('Native transcript is already bound to another lifecycle', 'agent_messaging_address_busy');
  if (!known && !current.lastUpstreamSessionId) return current;

  // /clear (and equivalent native identity changes) must not carry mail, aliases,
  // memberships or subscriptions into the new conversation. Keep old history.
  await db.update(agentBusAddresses).set({
    currentSessionId: null, receiveHeartbeatAt: null,
    readiness: current.lastUpstreamSessionId ? 'resumable' : 'offline',
    callPin: null, callPinExpiresAt: null, updatedAt: now,
  }).where(eq(agentBusAddresses.id, current.id));
  const id = randomUUID();
  const next = known ? {
    ...known, currentSessionId: session.id, bindingGeneration: known.bindingGeneration + 1,
    continuity: 'native', receiveHeartbeatAt: null, lastSeenAt: now, updatedAt: now,
  } : {
    ...current, id, address: `agent:${id}`, displayAlias: null,
    lastUpstreamSessionId: nativeId, bindingGeneration: 1, continuity: 'native',
    callPin: null, callPinExpiresAt: null, receiveHeartbeatAt: null,
    createdAt: now, updatedAt: now, lastSeenAt: now,
  };
  if (known) {
    await db.update(agentBusAddresses).set({
      currentSessionId: session.id, bindingGeneration: next.bindingGeneration,
      continuity: 'native', receiveHeartbeatAt: null, lastSeenAt: now, updatedAt: now,
      adapterProtocol: current.adapterProtocol, adapterCapabilities: current.adapterCapabilities,
    }).where(eq(agentBusAddresses.id, known.id));
  } else {
    await db.insert(agentBusAddresses).values(next);
  }
  await db.update(agentSessions).set({
    agentBusAddressId: next.id, bindingGeneration: next.bindingGeneration,
  }).where(eq(agentSessions.id, session.id));
  const launchName = await moveLaunchNameLocked(db, session.id, next.id, now);
  return { ...next, launchName };
}
