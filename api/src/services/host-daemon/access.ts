import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  hosts,
  hostDaemonSessions,
  hostDaemonOperations,
  agentBusAddresses,
  agentBusMessages,
  type Host,
} from '../../db/schema.js';
import { insecureWindowActive } from '../insecure-window.js';
import { clampInsecureMinutes, DEFAULT_INSECURE_WINDOW_MINUTES } from '../host-management.js';
import { activeHostEngines } from '../host-engine-policy.js';
import { readFleetEngineState } from '../engine-switch.js';
import type { Engine } from '../../util/engine.js';
import type { DaemonRuntime, DaemonSettings } from './policy.js';

export type DaemonDb = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export function daemonAccess(
  host: Pick<Host, 'status' | 'secure' | 'insecureEnabledUntil'> &
    Partial<Pick<Host, 'insecureSessionRenewalBlocked'>>,
) {
  const allowed =
    host.status === 'active' &&
    (host.secure === 1 || (!host.insecureSessionRenewalBlocked && insecureWindowActive(host)));
  return {
    allowed,
    reason: allowed ? null : host.status !== 'active' ? 'host_access_blocked' : 'insecure_window_closed',
    secure: host.secure === 1,
    enabled_until: host.insecureEnabledUntil ? new Date(host.insecureEnabledUntil).toISOString() : null,
  };
}

/** A transport heartbeat alone is never evidence of running native work. */
export async function renewDaemonWindow(
  db: DaemonDb,
  hostId: number,
  runtime: DaemonRuntime,
  settings: DaemonSettings,
  activeSessions: string[],
  now = Date.now(),
): Promise<boolean> {
  const age = now - Date.parse(runtime.heartbeat_at);
  if (!settings.enabled || !runtime.connected || runtime.error || !Number.isFinite(age) || age < 0 || age >= 45_000) return false;
  // Serializes with operator enable/disable and acceptance checks. Never reopen
  // an expired grant, and never undo a manual closure.
  const [host] = await db.select().from(hosts).where(eq(hosts.id, hostId)).for('update');
  if (!host || host.secure === 1 || host.insecureSessionRenewalBlocked || !daemonAccess(host).allowed)
    return false;
  const minutes = clampInsecureMinutes(host.insecureWindowMinutes, DEFAULT_INSECURE_WINDOW_MINUTES);
  if (minutes <= 0) return false;
  const work = await db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.hostId, hostId));
  const allowedEngines = activeHostEngines(host.engines, await readFleetEngineState(db));
  let live = false;
  for (const session of work) {
    if (!runtime.engines.includes(session.engine) || !allowedEngines.includes(session.engine as Engine)) continue;
    if (session.status === 'running' && activeSessions.includes(session.id)) {
      const accepted = await db
        .select()
        .from(hostDaemonOperations)
        .where(
          and(eq(hostDaemonOperations.sessionId, session.id), eq(hostDaemonOperations.status, 'accepted')),
        )
        .limit(1);
      // Peer work has a separately authenticated durable message acceptance.
      const peer = session.activeMessageId
        ? await db
            .select()
            .from(agentBusMessages)
            .where(
              and(
                eq(agentBusMessages.id, session.activeMessageId),
                eq(agentBusMessages.status, 'accepted'),
                eq(agentBusMessages.targetAddressId, session.addressId!),
              ),
            )
            .limit(1)
        : [];
      if (accepted.length || peer.length) live = true;
    } else if (['idle', 'waiting'].includes(session.status) && session.addressId) {
      const timeout = session.status === 'waiting' ? settings.question_minutes : settings.idle_minutes;
      const elapsed = now - Date.parse(session.lastActivityAt);
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeout * 60_000) continue;
      const [address] = await db
        .select()
        .from(agentBusAddresses)
        .where(eq(agentBusAddresses.id, session.addressId));
      if (address?.lastUpstreamSessionId) live = true;
    }
    if (live) break;
  }
  if (!live) return false;
  const current = new Date(host.insecureEnabledUntil!).getTime();
  const next = now + minutes * 60_000;
  if (next <= current) return false;
  await db
    .update(hosts)
    .set({ insecureEnabledUntil: new Date(next), updatedAt: new Date(now).toISOString() })
    .where(eq(hosts.id, hostId));
  return true;
}
