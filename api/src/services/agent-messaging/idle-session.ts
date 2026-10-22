import { and, eq, sql, type Placeholder } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusAddresses, agentBusMessages, agentMessages, agentSessions, hosts, versions } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { sha256 } from '../../security/hash.js';
import { isEngine } from '../../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { deriveAddressPresence, isFreshPresenceTimestamp } from '../agent-presence.js';
import { receiverReady, receiverState } from '../agent-receiver-state.js';
import { hostEnginesList } from '../host-engine-policy.js';
import { isTruthyFlagValue } from '../settings.js';
import { AGENT_MESSAGING_ENABLED_KEY, AGENT_MESSAGING_RECEIVE_FRESH_SECONDS } from './constants.js';
import { messagingHostEligible } from './eligibility.js';
import { hostAuthFingerprint, safeHashEqual } from './internals.js';

/**
 * Certify only a valid, empty poll. All uncertain/invalid/nonempty cases retain
 * the existing locked path and its error order, admission and delivery fences.
 *
 * Gates and absence MUST come from one statement's MVCC snapshot. Separate
 * reads could see an old receiver generation, then an empty queue after its
 * successor consumed a message, with no valid linearization point in between.
 */
type PollMode = 'presence' | 'peer' | 'portal';
function pollQuery(db: Database, sessionId: string | Placeholder, mode: PollMode) {
  return db.select({
    session: {
      id: agentSessions.id, engine: agentSessions.engine, endedAt: agentSessions.endedAt,
      bridgeExpiresAt: agentSessions.bridgeExpiresAt, hostAuthFingerprint: agentSessions.hostAuthFingerprint,
      bindingGeneration: agentSessions.bindingGeneration, bridgeTokenHash: agentSessions.bridgeTokenHash,
      receiveHeartbeatAt: agentSessions.receiveHeartbeatAt, receiver: agentSessions.receiver, heartbeatAt: agentSessions.heartbeatAt,
    },
    address: {
      id: agentBusAddresses.id, hostId: agentBusAddresses.hostId, engine: agentBusAddresses.engine,
      currentSessionId: agentBusAddresses.currentSessionId, bindingGeneration: agentBusAddresses.bindingGeneration,
      enabled: agentBusAddresses.enabled, archivedAt: agentBusAddresses.archivedAt, readiness: agentBusAddresses.readiness,
      lastUpstreamSessionId: agentBusAddresses.lastUpstreamSessionId, receiveHeartbeatAt: agentBusAddresses.receiveHeartbeatAt,
    },
    host: {
      id: hosts.id, engines: hosts.engines, status: hosts.status, secure: hosts.secure,
      insecureEnabledUntil: hosts.insecureEnabledUntil, apiKey: hosts.apiKey, apiKeyHash: hosts.apiKeyHash,
    },
    enabled: sql<string | null>`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = ${mode === 'portal' ? 'agent_portal_enabled' : AGENT_MESSAGING_ENABLED_KEY} LIMIT 1)`,
    engineDisabled: sql<string | null>`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = CONCAT(${agentSessions.engine}, '_engine_disabled') LIMIT 1)`,
  }).from(agentSessions)
    .innerJoin(hosts, eq(hosts.id, agentSessions.hostId))
    .innerJoin(agentBusAddresses, eq(agentBusAddresses.id, agentSessions.agentBusAddressId))
    .where(and(
      eq(agentSessions.id, sessionId),
      // Superset of every row the locked body can mutate: claim/expiry/retry,
      // replay and stale presence notices. Presence-return also consumes
      // awaitingPresence on accepted relay work; never exclude accepted rows.
      mode === 'portal' ? sql`NOT EXISTS (SELECT 1 FROM ${agentMessages}
        WHERE ${agentMessages.sessionId} = ${agentSessions.id} AND ${agentMessages.status} IN ('queued', 'leased'))` : sql`NOT EXISTS (SELECT 1 FROM ${agentBusMessages}
        WHERE ${agentBusMessages.targetAddressId} = ${agentBusAddresses.id}
          AND (${agentBusMessages.status} IN ('queued', 'leased', 'accepted')
          ${mode === 'peer' ? sql`OR (${agentBusMessages.status} = 'batched' AND EXISTS (
            SELECT 1 FROM agent_bus_messages digest_root WHERE digest_root.id = ${agentBusMessages.digestId}
              AND digest_root.accepted_at IS NULL AND digest_root.status IN ('expired','dead','canceled')
          ))` : sql``})
          ${mode === 'peer' ? sql`` : sql`AND ${agentBusMessages.awaitingPresence} = 1`})`,
    )).limit(1);
}

// Cache SQL construction and row mapping, never results or authorization.
// Only session_id is dynamic SQL input; credentials/time are checked below.
type PreparedPoll = ReturnType<ReturnType<typeof pollQuery>['prepare']>;
const compiled = new WeakMap<Database, Map<PollMode, PreparedPoll>>();
async function readPoll(db: Database, sessionId: string, mode: PollMode) {
  if (!('$client' in db)) return pollQuery(db, sessionId, mode);
  let modes = compiled.get(db);
  if (!modes) { modes = new Map(); compiled.set(db, modes); }
  let query = modes.get(mode);
  if (!query) { query = pollQuery(db, sql.placeholder('session_id'), mode).prepare(); modes.set(mode, query); }
  return query.execute({ session_id: sessionId });
}

export async function idleSessionPoll(
  db: Database,
  sessionId: string,
  env: Env,
  claim?: { bridgeToken: string; receiverGeneration?: string; requireReceiver?: boolean; source?: 'peer' | 'portal' },
): Promise<boolean> {
  const [row] = await readPoll(db, sessionId, claim ? claim.source ?? 'peer' : 'presence');
  if (!row) return false;
  const { session, address, host } = row;
  const now = nowIso();
  if (!isTruthyFlagValue(row.enabled, false) || isTruthyFlagValue(row.engineDisabled) ||
    !isEngine(session.engine) || !hostEnginesList(host.engines).includes(session.engine) ||
    !messagingHostEligible(host) || session.endedAt || session.bridgeExpiresAt <= now ||
    !safeHashEqual(hostAuthFingerprint(host), session.hostAuthFingerprint) ||
    address.hostId !== host.id || address.engine !== session.engine ||
    address.currentSessionId !== session.id || address.bindingGeneration !== session.bindingGeneration ||
    address.enabled !== 1 || address.archivedAt) return false;
  if (claim) {
    if (!safeHashEqual(sha256(claim.bridgeToken), session.bridgeTokenHash)) return false;
    const receiver = receiverState(session.receiver);
    if (claim.source === 'portal') return Boolean(receiver && receiver.generation === claim.receiverGeneration &&
      receiverReady(receiver, 'portal') && isFreshPresenceTimestamp(session.heartbeatAt,
        Date.now() - env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS * 1000, Date.now()));
    if (
      !session.receiveHeartbeatAt || session.receiveHeartbeatAt <= isoOffsetSeconds(-AGENT_MESSAGING_RECEIVE_FRESH_SECONDS)) return false;
    if (claim.requireReceiver && !receiver) return false;
    if (receiver && (receiver.generation !== claim.receiverGeneration || !receiverReady(receiver, 'peer'))) return false;
    return true;
  }
  const cutoff = isoOffsetSeconds(-env.AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS);
  return deriveAddressPresence(address, session, cutoff) === 'listening';
}
