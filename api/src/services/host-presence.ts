import { and, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentSessions, hostDaemons, type Host } from '../db/schema.js';
import { isFreshPresenceTimestamp } from './agent-presence.js';
import { hostAuthFingerprint, safeHashEqual } from './agent-messaging/internals.js';
import { activeHostEngines } from './host-engine-policy.js';
import { readFleetEngineState } from './engine-switch.js';

export const HOST_PRESENCE_FRESH_SECONDS = 45;

/** Connection evidence is independent of authentication readiness and admin edits. */
export function hostPresence(host: Pick<Host, 'status' | 'expiresAt' | 'lastContactAt'>, evidence: Array<string | null>, now = Date.now()) {
  const fresh = evidence.filter((at): at is string => isFreshPresenceTimestamp(at, now - HOST_PRESENCE_FRESH_SECONDS * 1000, now));
  const heartbeat = fresh.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const available = host.status === 'active' && (!host.expiresAt || Date.parse(host.expiresAt) > now);
  return {
    presence: available && heartbeat ? 'online' as const : 'offline' as const,
    presence_heartbeat_at: heartbeat,
    presence_observed_at: new Date(now).toISOString(),
    presence_fresh_seconds: HOST_PRESENCE_FRESH_SECONDS,
    last_contact_at: host.lastContactAt ?? null,
  };
}

/** Batched for list/detail: provider auth timestamps are never liveness evidence. */
export async function hostPresenceViews(db: Database, rows: Host[]) {
  if (!rows.length) return new Map<number, ReturnType<typeof hostPresence>>();
  const ids = rows.map(h => h.id);
  const [sessions, daemons, fleet] = await Promise.all([
    db.select().from(agentSessions).where(and(inArray(agentSessions.hostId, ids), isNull(agentSessions.endedAt))),
    db.select().from(hostDaemons).where(inArray(hostDaemons.hostId, ids)),
    readFleetEngineState(db),
  ]);
  const now = Date.now();
  return new Map(rows.map(host => {
    const engines = activeHostEngines(host.engines, fleet);
    const evidence = sessions.filter(s => s.hostId === host.id && engines.includes(s.engine as typeof engines[number]) && Date.parse(s.bridgeExpiresAt) > now && safeHashEqual(s.hostAuthFingerprint, hostAuthFingerprint(host)))
      .map(s => s.heartbeatAt);
    const runtime = daemons.find(d => d.hostId === host.id)?.runtime;
    if (runtime?.connected) evidence.push(runtime.heartbeat_at);
    return [host.id, hostPresence(host, evidence, now)];
  }));
}
