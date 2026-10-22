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
const flag = (name: string) => sql<string | null>`(SELECT ${versions.version} FROM ${versions} WHERE ${versions.name} = ${name} LIMIT 1)`;
const parsed = (value: unknown): unknown[] => {
  if (value == null) return [];
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(list) ? list : [];
};

/**
 * Certify only a valid, idle relay poll, from ONE statement's MVCC snapshot: relay credential, host, daemon gate,
 * fleet flags, candidate addresses, the host's daemon sessions and "no pending work for any candidate". A relay poll
 * used to read those in four to five statements. Anything uncertain, invalid or non-empty returns false, and the caller
 * runs the unchanged path with its admission errors, order and locked claim fences.
 */
export async function relayIdleProof(db: Database, relayId: string, rawToken: string): Promise<boolean> {
  if (!UUID.test(relayId)) return false;
  const now = nowIso();
  // The daemon relay serves its service user's addresses; match both spellings and filter exactly below.
  const candidates = sql`${agentBusAddresses.hostId} = ${agentBusRelays.hostId}
    AND ${agentBusAddresses.username} IN (${agentBusRelays.username}, REGEXP_REPLACE(${agentBusRelays.username}, ':daemon$', ''))
    AND ${agentBusAddresses.enabled} = 1 AND ${agentBusAddresses.archivedAt} IS NULL AND ${agentBusAddresses.currentSessionId} IS NULL`;
  const [row] = await db
    .select({
      relay: {
        status: agentBusRelays.status, username: agentBusRelays.username, tokenHash: agentBusRelays.tokenHash,
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
      addresses: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${agentBusAddresses.id}, ${agentBusAddresses.engine}, ${agentBusAddresses.username}))
        FROM ${agentBusAddresses} WHERE ${candidates})`,
      remote: sql<unknown>`(SELECT JSON_ARRAYAGG(JSON_ARRAY(${hostDaemonSessions.addressId}, ${hostDaemonSessions.status}))
        FROM ${hostDaemonSessions} WHERE ${hostDaemonSessions.hostId} = ${agentBusRelays.hostId} AND ${hostDaemonSessions.addressId} IS NOT NULL)`,
      pending: sql<number>`EXISTS (SELECT 1 FROM ${agentBusMessages}
        WHERE ${agentBusMessages.targetAddressId} IN (SELECT ${agentBusAddresses.id} FROM ${agentBusAddresses} WHERE ${candidates})
          AND ${pendingRelayWork(db, now)})`,
    })
    .from(agentBusRelays)
    .innerJoin(hosts, eq(hosts.id, agentBusRelays.hostId))
    .leftJoin(hostDaemons, eq(hostDaemons.hostId, agentBusRelays.hostId))
    .where(eq(agentBusRelays.id, relayId))
    .limit(1);
  if (!row) return false;
  const { relay, host } = row;
  if (!isTruthyFlagValue(row.enabled, false)) return false;
  if (relay.status !== 'active' || !relay.tokenHash || !safeHashEqual(sha256(rawToken ?? ''), relay.tokenHash)) return false;
  if (!messagingHostEligible(host)) return false;
  if (relay.tokenExpiresAt == null || relay.tokenExpiresAt <= now) return false;
  if (!relay.hostAuthFingerprint || !safeHashEqual(hostAuthFingerprint(host), relay.hostAuthFingerprint)) return false;
  const daemonRelay = jsonRecord(relay.capabilities)?.host_daemon === true;
  // A draining or non-resident relay keeps the full path, which decides between drain and refusal.
  if (!row.daemon || !(daemonRelay ? daemonAccepting(row.daemon) : daemonResidentFor(row.daemon, relay.username))) return false;
  const targetUsername = daemonRelay ? relay.username.replace(/:daemon$/, '') : relay.username;
  const fleet = {
    codex: !isTruthyFlagValue(row.codexDisabled),
    claude: !isTruthyFlagValue(row.claudeDisabled),
    grok: !isTruthyFlagValue(row.grokDisabled),
  };
  const engines = activeHostEngines(host.engines, fleet);
  const remote = parsed(row.remote) as Array<[string, string]>;
  const remoteIds = new Set(remote.map(([address]) => address));
  const eligible = (parsed(row.addresses) as Array<[string, string, string]>).filter(([id, engine, username]) =>
    username === targetUsername && isEngine(engine) && engines.includes(engine) &&
    (daemonRelay
      ? remote.some(([address, status]) => address === id && (status === 'idle' || status === 'waiting'))
      : !remoteIds.has(id)));
  if (eligible.length === 0) return true;
  return !Number(row.pending);
}
