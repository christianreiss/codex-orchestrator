/**
 * Host-scope agent inventory: the read-only answer to "which agents are
 * registered on this host, which are resumable, and what work is still
 * pending for them" for an operator shell outside any managed lifecycle.
 *
 * Split out of `../agent-messaging.ts`. Authentication is the host API key,
 * so the query is pinned to that one host; it never accepts a host id, scope
 * or workspace filter, sends nothing and claims nothing.
 */

import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { agentBusAddresses, agentBusMessages, agentSessions, type Host } from '../../db/schema.js';
import type { Engine } from '../../util/engine.js';
import { isoOffsetSeconds, nowIso } from '../../util/timestamp.js';
import { deriveAddressPresence, isPresent } from '../agent-presence.js';
import { receiverView } from '../agent-receiver-state.js';
import { readFleetEngineState } from '../engine-switch.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { LIVE_MESSAGE_STATUSES } from './constants.js';
import { publicAddress } from './views.js';

export interface HostInventoryFilters {
  engine?: Engine;
  includeOffline?: boolean;
}

export interface HostInventoryCore {
  readonly db: Database;
  readonly presenceFreshSeconds: number;
  isEnabled(): Promise<boolean>;
}

export async function listHostInventory(
  core: HostInventoryCore,
  host: Host,
  filters: HostInventoryFilters = {},
): Promise<Record<string, unknown>> {
  const enabled = await core.isEnabled();
  const predicates = [eq(agentBusAddresses.hostId, host.id), isNull(agentBusAddresses.archivedAt)];
  if (filters.engine) predicates.push(eq(agentBusAddresses.engine, filters.engine));
  const rows = await core.db
    .select({
      address: agentBusAddresses,
      session: {
        id: agentSessions.id,
        upstreamSessionId: agentSessions.upstreamSessionId,
        cwd: agentSessions.cwd,
        heartbeatAt: agentSessions.heartbeatAt,
        endedAt: agentSessions.endedAt,
        receiver: agentSessions.receiver,
      },
    })
    .from(agentBusAddresses)
    .leftJoin(agentSessions, eq(agentSessions.id, agentBusAddresses.currentSessionId))
    .where(and(...predicates))
    .orderBy(asc(agentBusAddresses.address));
  const ids = rows.map((row) => row.address.id);
  const queueRows = ids.length
    ? await core.db
        .select({ target: agentBusMessages.targetAddressId, status: agentBusMessages.status, value: count() })
        .from(agentBusMessages)
        .where(and(inArray(agentBusMessages.targetAddressId, ids), inArray(agentBusMessages.status, [...LIVE_MESSAGE_STATUSES])))
        .groupBy(agentBusMessages.targetAddressId, agentBusMessages.status)
    : [];
  const queues = new Map<string, Record<string, number>>();
  for (const row of queueRows) {
    if (!row.target) continue;
    const counts = queues.get(row.target) ?? {};
    counts[row.status] = Number(row.value);
    queues.set(row.target, counts);
  }
  const active = activeHostEngines(host.engines, await readFleetEngineState(core.db));
  const freshAfter = isoOffsetSeconds(-core.presenceFreshSeconds);
  const addresses = rows
    .map((row) => ({ ...row, presence: deriveAddressPresence(row.address, row.session, freshAfter) }))
    .filter((row) => filters.includeOffline !== false || isPresent(row.presence))
    .map((row) => {
      const counts = queues.get(row.address.id) ?? {};
      return {
        ...publicAddress(row.address, host.fqdn, row.presence),
        cwd: row.session?.cwd ?? row.address.cwd,
        receiver: receiverView(row.session?.receiver),
        current_session_id: row.address.currentSessionId,
        upstream_session_id: row.session?.upstreamSessionId ?? null,
        last_upstream_session_id: row.address.lastUpstreamSessionId,
        engine_active: active.includes(row.address.engine as Engine),
        queue_depth: Object.values(counts).reduce((sum, value) => sum + value, 0),
        accepted_work: counts.accepted ?? 0,
        queue: counts,
      };
    });
  return {
    scope: 'host',
    read_only: true,
    enabled,
    host_id: host.id,
    fqdn: host.fqdn,
    observed_at: nowIso(),
    total: addresses.length,
    addresses,
  };
}
