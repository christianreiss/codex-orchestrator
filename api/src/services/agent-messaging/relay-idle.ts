import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { agentBusAddresses, agentBusMessages, agentBusRelays, hostDaemonSessions, hostDaemons, hosts, versions } from '../../db/schema.js';
import { sha256 } from '../../security/hash.js';
import { isEngine } from '../../util/engine.js';
import { nowIso } from '../../util/timestamp.js';
import { ENGINE_DISABLED_FLAGS } from '../engine-switch.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { daemonAccepting, daemonResidentFor } from '../host-daemon/policy.js';
import { isTruthyFlagValue } from '../settings.js';
import { AGENT_MESSAGING_ENABLED_KEY } from './constants.js';
import { strictFifoDeliveryReady } from './delivery-readiness.js';
import { messagingHostEligible } from './eligibility.js';
import { hostAuthFingerprint, safeHashEqual } from './internals.js';
import { jsonRecord } from './normalize.js';
import { relayDigestRecoveryPending } from './relay-digests.js';
import type { AgentMessagingDb } from './types.js';

/**
 * Every queued/leased/notice row the locked relay claim can change. Over-matching only costs the locked path;
 * under-matching would skip a state change. Shared by the plain peek and the one-statement idle proof.
 */
export function pendingRelayWork(db: AgentMessagingDb, now: string) {
  return or(
    eq(agentBusMessages.status, 'leased'),
    relayDigestRecoveryPending(db),
    and(eq(agentBusMessages.status, 'queued'), or(
      and(lte(agentBusMessages.nextAttemptAt, now), strictFifoDeliveryReady()),
      lte(agentBusMessages.expiresAt, now),
      // Routine retirement can act before a queued notice's retry time.
      inArray(agentBusMessages.kind, ['presence_notice', 'publication', 'digest']),
    )),
    and(eq(agentBusMessages.kind, 'presence_notice'), inArray(agentBusMessages.status, ['accepted', 'batched'])),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The daemon relay serves its service user's addresses; every other relay serves its own user. */
function relayTargetUsername(username: string, capabilities: unknown): string {
  return jsonRecord(capabilities)?.host_daemon === true ? username.replace(/:daemon$/, '') : username;
}

// A relay's host and user never change after registration (re-registration keeps both and bumps the generation).
// Knowing them up front lets the proof look addresses up by index instead of through a correlated expression,
// which MySQL could not index (2026-10-22: 121 rows per check). The proof re-reads both and drops a stale entry.
interface RelayIdentity { hostId: number; username: string; target: string }
const relayIdentities = new Map<string, RelayIdentity>();
async function relayIdentity(db: Database, relayId: string): Promise<RelayIdentity | null> {
  const known = relayIdentities.get(relayId);
  if (known) return known;
  const [row] = await db
    .select({ hostId: agentBusRelays.hostId, username: agentBusRelays.username, capabilities: agentBusRelays.capabilities })
    .from(agentBusRelays)
    .where(eq(agentBusRelays.id, relayId))
    .limit(1);
  if (!row) return null;
  if (relayIdentities.size >= 4096) relayIdentities.clear();
  const identity = { hostId: row.hostId, username: row.username, target: relayTargetUsername(row.username, row.capabilities) };
  relayIdentities.set(relayId, identity);
  return identity;
}
const flag = (name: string) => sql<string | null>`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = ${name} LIMIT 1)`;
const parsed = (value: unknown): unknown[] => {
  if (value == null) return [];
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(list) ? list : [];
};

/**
 * Certify only a valid, idle relay poll, from ONE statement's MVCC snapshot (plus the cached immutable relay
 * identity, re-verified in that statement): relay credential, host, daemon gate,
 * fleet flags, the host's daemon sessions and the candidate addresses that have pending work. A relay poll
 * used to read those in four to five statements. Anything uncertain, invalid or non-empty returns false, and the caller
 * runs the unchanged path with its admission errors, order and locked claim fences.
 */
export async function relayIdleProof(db: Database, relayId: string, rawToken: string): Promise<boolean> {
  if (!UUID.test(relayId)) return false;
  const identity = await relayIdentity(db, relayId);
  if (!identity) return false;
  const now = nowIso();
  const [row] = await relayProofQuery(db, relayId, identity, now);
  return certifyRelayIdle(row, relayId, identity, rawToken, now);
}

/** The proof's statement; exported so performance work can EXPLAIN exactly what runs. */
export function relayProofQuery(db: Database, relayId: string, identity: RelayIdentity, now: string) {
  const candidates = sql`${agentBusAddresses.hostId} = ${identity.hostId} AND ${agentBusAddresses.username} = ${identity.target}
    AND ${agentBusAddresses.enabled} = 1 AND ${agentBusAddresses.archivedAt} IS NULL AND ${agentBusAddresses.currentSessionId} IS NULL`;
  return db
    .select({
      relay: {
        hostId: agentBusRelays.hostId, status: agentBusRelays.status, username: agentBusRelays.username, tokenHash: agentBusRelays.tokenHash,
        tokenExpiresAt: agentBusRelays.tokenExpiresAt, hostAuthFingerprint: agentBusRelays.hostAuthFingerprint,
        capabilities: agentBusRelays.capabilities,
      },
      host: {
        status: hosts.status, secure: hosts.secure, insecureEnabledUntil: hosts.insecureEnabledUntil,
        apiKey: hosts.apiKey, apiKeyHash: hosts.apiKeyHash, engines: hosts.engines,
      },
      daemon: hostDaemons.settings,
      enabled: flag(AGENT_MESSAGING_ENABLED_KEY),
      codexDisabled: flag(ENGINE_DISABLED_FLAGS.codex),
      claudeDisabled: flag(ENGINE_DISABLED_FLAGS.claude),
      grokDisabled: flag(ENGINE_DISABLED_FLAGS.grok),
      remote: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${hostDaemonSessions.addressId}, ${hostDaemonSessions.status}))
        FROM ${hostDaemonSessions} WHERE ${hostDaemonSessions.hostId} = ${identity.hostId} AND ${hostDaemonSessions.addressId} IS NOT NULL)`,
      // Only candidates WITH pending work: driven from the few pending rows, not from every dormant address
      // (a single user had 1041 dormant addresses on one host on 2026-10-22).
      pendingTargets: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${agentBusAddresses.id}, ${agentBusAddresses.engine}))
        FROM ${agentBusMessages} INNER JOIN ${agentBusAddresses} ON ${agentBusAddresses.id} = ${agentBusMessages.targetAddressId}
        WHERE ${candidates} AND ${pendingRelayWork(db, now)})`,
    })
    .from(agentBusRelays)
    .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
    .leftJoin(hostDaemons, eq(hostDaemons.hostId, agentBusRelays.hostId))
    .where(eq(agentBusRelays.id, relayId))
    .limit(1);
}

type RelayProofRow = Awaited<ReturnType<typeof relayProofQuery>>[number];

function certifyRelayIdle(row: RelayProofRow | undefined, relayId: string, identity: RelayIdentity, rawToken: string, now: string): boolean {
  if (!row) {
    relayIdentities.delete(relayId);
    return false;
  }
  const { relay, host } = row;
  if (relay.hostId !== identity.hostId || relay.username !== identity.username ||
    relayTargetUsername(relay.username, relay.capabilities) !== identity.target) {
    relayIdentities.delete(relayId);
    return false;
  }
  if (!isTruthyFlagValue(row.enabled, false)) return false;
  if (relay.status !== 'active' || !relay.tokenHash || !safeHashEqual(sha256(rawToken ?? ''), relay.tokenHash)) return false;
  if (!messagingHostEligible(host)) return false;
  if (relay.tokenExpiresAt == null || relay.tokenExpiresAt <= now) return false;
  if (!relay.hostAuthFingerprint || !safeHashEqual(hostAuthFingerprint(host), relay.hostAuthFingerprint)) return false;
  const daemonRelay = jsonRecord(relay.capabilities)?.host_daemon === true;
  // A draining or non-resident relay keeps the full path, which decides between drain and refusal.
  if (!row.daemon || !(daemonRelay ? daemonAccepting(row.daemon) : daemonResidentFor(row.daemon, relay.username))) return false;
  const fleet = {
    codex: !isTruthyFlagValue(row.codexDisabled),
    claude: !isTruthyFlagValue(row.claudeDisabled),
    grok: !isTruthyFlagValue(row.grokDisabled),
  };
  const engines = activeHostEngines(host.engines, fleet);
  const remote = parsed(row.remote) as Array<[string, string]>;
  const remoteIds = new Set(remote.map(([address]) => address));
  // Idle exactly when no address this relay may serve has work the locked path could change.
  return !(parsed(row.pendingTargets) as Array<[string, string]>).some(([id, engine]) =>
    isEngine(engine) && engines.includes(engine) &&
    (daemonRelay
      ? remote.some(([address, status]) => address === id && (status === 'idle' || status === 'waiting'))
      : !remoteIds.has(id)));
}
