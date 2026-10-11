import { and, eq, isNull, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentBusAddresses, agentSessions, agentWatchdogs, hosts, sessionHousekeepingReservations } from '../db/schema.js';
import type { Engine } from '../util/engine.js';
import { SettingsService } from './settings.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';

export interface HousekeepingPolicy { enabled: boolean; retention_days: number; max_bytes: number; min_age_days: number }
export const DEFAULT_HOUSEKEEPING: HousekeepingPolicy = { enabled: true, retention_days: 30, max_bytes: 5 * 1024 ** 3, min_age_days: 7 };
export function validateHousekeeping(value: unknown): HousekeepingPolicy {
  const p = value as HousekeepingPolicy;
  if (!p || typeof p.enabled !== 'boolean' || !Number.isInteger(p.retention_days) || p.retention_days < 1 || p.retention_days > 3650 ||
      !Number.isSafeInteger(p.max_bytes) || p.max_bytes < 1024 ** 2 || p.max_bytes > 1024 ** 4 ||
      !Number.isInteger(p.min_age_days) || p.min_age_days < 1 || p.min_age_days > p.retention_days)
    throw new ValidationError('Housekeeping needs enabled, retention_days (1–3650), max_bytes (1 MiB–1 TiB), and min_age_days (1–retention_days)');
  return { enabled: p.enabled, retention_days: p.retention_days, max_bytes: p.max_bytes, min_age_days: p.min_age_days };
}
const key = (engine: Engine, hostId?: number) => `session_housekeeping_${engine}${hostId == null ? '' : `_host_${hostId}`}`;
export async function housekeepingPolicy(db: Database, engine: Engine, hostId?: number) {
  const settings = new SettingsService(db);
  const raw = hostId == null ? null : await settings.getRaw(key(engine, hostId));
  const fleetRaw = await settings.getRaw(key(engine));
  const fleet = fleetRaw ? validateHousekeeping(JSON.parse(fleetRaw)) : { ...DEFAULT_HOUSEKEEPING };
  return { ...(raw ? validateHousekeeping(JSON.parse(raw)) : fleet), source: raw ? 'host' : 'fleet', override: raw ? validateHousekeeping(JSON.parse(raw)) : null, fleet };
}
export async function storeHousekeeping(db: Database, engine: Engine, value: unknown, hostId?: number) {
  await new SettingsService(db).set(key(engine, hostId), value === null && hostId != null ? '' : JSON.stringify(validateHousekeeping(value)));
  return housekeepingPolicy(db, engine, hostId);
}

// Reservations intentionally have no expiry: a lost process may have renamed
// files already. Only the same journal token may finish/recover the operation.
// An expiry must never reopen native launches while indexes are inconsistent.
export async function assertHousekeepingAvailable(db: Pick<Database, 'select'>, hostId: number, engine: string) {
  await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).for('update');
  const rows = await db.select().from(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine))).limit(1);
  if (rows.length) throw new ConflictError('Session housekeeping is recovering or running on this host', 'session_housekeeping_busy');
}
export async function housekeepingProtection(db: Database, hostId: number, engine: Engine) {
  // Every resumable fleet address is protected, including paused wakes and
  // pending work. This stronger rule avoids dependence on messaging switches
  // or queue TTLs and makes later schedule creation safe without a race.
  const addresses = await db.select({ id: agentBusAddresses.id, lastUpstreamSessionId: agentBusAddresses.lastUpstreamSessionId }).from(agentBusAddresses)
    .where(and(eq(agentBusAddresses.hostId, hostId), eq(agentBusAddresses.engine, engine)));
  const live = await db.select({ upstreamSessionId: agentSessions.upstreamSessionId }).from(agentSessions)
    .where(and(eq(agentSessions.hostId, hostId), eq(agentSessions.engine, engine), isNull(agentSessions.endedAt)));
  const addressIds=addresses.map(r=>r.id);
  const watchdogs=addressIds.length ? await db.select({nativeSessionId:agentWatchdogs.nativeSessionId}).from(agentWatchdogs).where(and(inArray(agentWatchdogs.targetAddressId,addressIds),inArray(agentWatchdogs.status,['watching','recovering','capacity_wait']))) : [];
  return [...new Set([...addresses.map(r => r.lastUpstreamSessionId), ...live.map(r => r.upstreamSessionId), ...watchdogs.map(r=>r.nativeSessionId)].filter((id): id is string => !!id))];
}
export async function reserveHousekeeping(db: Database, hostId: number, engine: Engine, token: string) {
  return db.transaction(async tx => {
    await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).for('update');
    const rows = await tx.select().from(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine)));
    if (rows.length && rows[0]!.token !== token) throw new ConflictError('Another housekeeping journal owns this engine', 'session_housekeeping_busy');
    if (!rows.length) await tx.insert(sessionHousekeepingReservations).values({ hostId, engine, token, createdAt: nowIso() });
    return { protected_ids: await housekeepingProtection(tx as unknown as Database, hostId, engine), policy: await housekeepingPolicy(tx as unknown as Database, engine, hostId) };
  });
}
export async function releaseHousekeeping(db: Database, hostId: number, engine: Engine, token: string) {
  await db.delete(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine), eq(sessionHousekeepingReservations.token, token)));
}
