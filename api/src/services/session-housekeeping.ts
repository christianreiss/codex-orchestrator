import {persistAuditLog} from './audit-log.js';
import { wsPublisher } from '../ws/publisher.js';
import { adminAudit } from '../control-plane/state/admin.js';
import { versions} from '../db/schema.js';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agentBusAddresses, agentSessions, agentWatchdogs, hosts, sessionHousekeepingReservations } from '../db/schema.js';
import type { Engine } from '../util/engine.js';
import { SettingsService } from './settings.js';
import { ConflictError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { mutateOwnerState, ownerRuntimeFor } from '../control-plane/state/runtime.js';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';

function ownedProtection(snapshot: OwnerStateSnapshot, hostId: number, engine: Engine): string[] {
  const addresses = snapshot.addresses.by('hostId', hostId).filter(row => row.engine === engine);
  const ids = new Set(addresses.map(row => row.id));
  const sessions = snapshot.sessions.by('hostId', hostId).filter(row => row.engine === engine && !row.endedAt);
  const watchdogs = snapshot.table('agentWatchdogs').all().filter(row => ids.has(row.targetAddressId) && ['watching','recovering','capacity_wait'].includes(row.status));
  return [...new Set([...addresses.map(row => row.lastUpstreamSessionId), ...sessions.map(row => row.upstreamSessionId), ...watchdogs.map(row => row.nativeSessionId)].filter((id): id is string => !!id))];
}
function ownedPolicy(snapshot: OwnerStateSnapshot, engine: Engine, hostId: number) {
  const raw = snapshot.setting(key(engine, hostId)), fleetRaw = snapshot.setting(key(engine));
  const fleet = fleetRaw ? validateHousekeeping(JSON.parse(fleetRaw)) : { ...DEFAULT_HOUSEKEEPING };
  const override = raw ? validateHousekeeping(JSON.parse(raw)) : null;
  return { ...(override ?? fleet), source: override ? 'host' : 'fleet', override, fleet };
}

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
  const owner=ownerRuntimeFor(db);
  if(owner){
    const normalized=value===null&&hostId!=null?null:validateHousekeeping(value);
    await mutateOwnerState(owner,{kind:'housekeeping.policy',payload:{engine,hostId:hostId??null,policy:normalized as unknown as import('../control-plane/commands.js').Json},prepare(ctx){
      if(hostId&&!ctx.snapshot.hosts.has(hostId))throw new Error('Host not found');
      const at=new Date().toISOString(),row={name:key(engine,hostId),version:normalized===null?'':JSON.stringify(normalized),updatedAt:at};
      ctx.draft.upsert('versions',row);ctx.write(tx=>tx.insert(versions).values(row).onDuplicateKeyUpdate({set:{version:row.version,updatedAt:at}}));
      const details={engine,policy:normalized};ctx.write(tx=>persistAuditLog(tx, {hostId:hostId??null,action:'admin.session_housekeeping',details:JSON.stringify(details),createdAt:at}));adminAudit(ctx,'settings.changed',details,at,hostId??null);return null;
    }});
    wsPublisher.publish('settings.changed',{key:key(engine,hostId)});
    return housekeepingPolicy(db,engine,hostId);
  }

  await new SettingsService(db).set(key(engine, hostId), value === null && hostId != null ? '' : JSON.stringify(validateHousekeeping(value)));
  return housekeepingPolicy(db, engine, hostId);
}

// Reservations intentionally have no expiry: a lost process may have renamed
// files already. Only the same journal token may finish/recover the operation.
// An expiry must never reopen native launches while indexes are inconsistent.
export async function assertHousekeepingAvailable(db: Pick<Database, 'select'>, hostId: number, engine: string) {
  const owner = ownerRuntimeFor(db);
  if (owner) { owner.assertOwner(); if (owner.state.snapshot().table('sessionHousekeepingReservations').by('hostId',hostId).some(row => row.engine === engine)) throw new ConflictError('Session housekeeping is recovering or running on this host','session_housekeeping_busy'); return; }
  await db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).for('update');
  const rows = await db.select().from(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine))).limit(1);
  if (rows.length) throw new ConflictError('Session housekeeping is recovering or running on this host', 'session_housekeeping_busy');
}
export async function housekeepingProtection(db: Database, hostId: number, engine: Engine) {
  const owner = ownerRuntimeFor(db); if (owner) { owner.assertOwner(); return ownedProtection(owner.state.snapshot(), hostId, engine); }
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
  const owner = ownerRuntimeFor(db);
  if (owner) return mutateOwnerState(owner, { kind:'housekeeping.reserve', principal:`host:${hostId}`, payload:{hostId,engine,token}, prepare(ctx) {
    if (!ctx.snapshot.hosts.has(hostId)) throw new ConflictError('Host no longer exists','host_not_found');
    const prior = ctx.snapshot.table('sessionHousekeepingReservations').by('hostId',hostId).find(row => row.engine === engine);
    if (prior && prior.token !== token) throw new ConflictError('Another housekeeping journal owns this engine','session_housekeeping_busy');
    if (!prior) { const row={hostId,engine,token,createdAt:nowIso()}; ctx.draft.upsert('sessionHousekeepingReservations',row); ctx.write(tx=>tx.insert(sessionHousekeepingReservations).values(row)); }
    return JSON.parse(JSON.stringify({protected_ids:ownedProtection(ctx.snapshot,hostId,engine),policy:ownedPolicy(ctx.snapshot,engine,hostId)})) as import('../control-plane/commands.js').Json;
  } }) as unknown as Promise<{protected_ids:string[];policy:ReturnType<typeof ownedPolicy>}>;
  return db.transaction(async tx => {
    await tx.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).for('update');
    const rows = await tx.select().from(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine)));
    if (rows.length && rows[0]!.token !== token) throw new ConflictError('Another housekeeping journal owns this engine', 'session_housekeeping_busy');
    if (!rows.length) await tx.insert(sessionHousekeepingReservations).values({ hostId, engine, token, createdAt: nowIso() });
    return { protected_ids: await housekeepingProtection(tx as unknown as Database, hostId, engine), policy: await housekeepingPolicy(tx as unknown as Database, engine, hostId) };
  });
}
export async function releaseHousekeeping(db: Database, hostId: number, engine: Engine, token: string) {
  const owner = ownerRuntimeFor(db);
  if (owner) { if (!owner.state.snapshot().table('sessionHousekeepingReservations').by('hostId',hostId).some(row=>row.engine===engine&&row.token===token)) return;
    await mutateOwnerState(owner,{kind:'housekeeping.release',principal:`host:${hostId}`,payload:{hostId,engine,token},prepare(ctx){for(const row of ctx.draft.table('sessionHousekeepingReservations').by('hostId',hostId))if(row.engine===engine&&row.token===token){ctx.draft.removeRow('sessionHousekeepingReservations',row);ctx.write(tx=>tx.delete(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId,hostId),eq(sessionHousekeepingReservations.engine,engine),eq(sessionHousekeepingReservations.token,token))));}return null;}}); return; }
  await db.delete(sessionHousekeepingReservations).where(and(eq(sessionHousekeepingReservations.hostId, hostId), eq(sessionHousekeepingReservations.engine, engine), eq(sessionHousekeepingReservations.token, token)));
}
