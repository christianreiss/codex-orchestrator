import { assertFleetEngineEnabledForAdmin } from './engine-switch.js';
import { parseEngine } from '../util/engine.js';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { agentNativeControls, agentSessions, hostDaemonPortalBindings, agentBusAddresses, agentWatchdogs, agentScheduleRuns, agentBusMessages } from '../db/schema.js';
import { ConflictError, NotFoundError } from '../http/errors.js';
import { stopWatchdogLocked, WATCHDOG_LIVE } from './watchdog-lifecycle.js';

export type NativeControl = typeof agentNativeControls.$inferSelect;
export function controlView(row: NativeControl | undefined, now = Date.now()) {
  if (!row) return null;
  const fresh = now - Date.parse(row.updatedAt) < 15_000;
  return { instance_id: row.instanceId, binding_generation: row.bindingGeneration,
    status: row.requestId && !fresh && ['requested', 'accepted'].includes(row.status) ? 'unknown' : row.status,
    request_id: row.requestId, available: fresh && row.status === 'ready', updated_at: row.updatedAt };
}

/** One stop per launch: retries cannot retarget a successor or execute twice. */
export class NativeStopService {
  constructor(private readonly db: Database) {}
  async get(sessionId: string) {
    const [row] = await this.db.select().from(agentNativeControls).where(eq(agentNativeControls.sessionId, sessionId));
    return controlView(row);
  }
  async poll(sessionId: string, instanceId: string, report?: { request_id: string; status: 'accepted' | 'exited' | 'refused' }) {
    if (!report) {
      // One fresh snapshot proves only an idle, still-bound process with a
      // recent checkpoint. Requests, reports and overdue checkpoints retain
      // the existing locked path; no queue or authorization result is cached.
      const [idle] = await this.db.select({
        instanceId: agentNativeControls.instanceId,
        generation: agentNativeControls.bindingGeneration,
        sessionGeneration: agentSessions.bindingGeneration,
        addressId: agentSessions.agentBusAddressId,
        addressSession: agentBusAddresses.currentSessionId,
        addressGeneration: agentBusAddresses.bindingGeneration,
        endedAt: agentSessions.endedAt,
        requestId: agentNativeControls.requestId,
        status: agentNativeControls.status,
        updatedAt: agentNativeControls.updatedAt,
      }).from(agentNativeControls)
        .innerJoin(agentSessions, eq(agentSessions.id, agentNativeControls.sessionId))
        .leftJoin(agentBusAddresses, eq(agentBusAddresses.id, agentSessions.agentBusAddressId))
        .where(eq(agentNativeControls.sessionId, sessionId)).limit(1);
      const age = Date.now() - Date.parse(idle?.updatedAt ?? '');
      if (idle && !idle.endedAt && idle.instanceId === instanceId &&
        idle.generation === idle.sessionGeneration && !idle.requestId && idle.status === 'ready' &&
        (!idle.addressId || (idle.addressSession === sessionId && idle.addressGeneration === idle.sessionGeneration)) &&
        age >= 0 && age < 7_000) {
        return { request_id: null, instance_id: idle.instanceId, binding_generation: idle.generation };
      }
    }
    return this.db.transaction(async tx => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).for('update');
      if (!session) throw new NotFoundError('Session not found');
      if (session.agentBusAddressId) {
        const [address] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)).for('update');
        if (!address || address.currentSessionId !== sessionId || address.bindingGeneration !== session.bindingGeneration)
          throw new ConflictError('Session binding changed', 'native_stop_binding_changed');
      }
      const [row] = await tx.select().from(agentNativeControls).where(eq(agentNativeControls.sessionId, sessionId)).for('update');
      const now = new Date().toISOString();
      if (!row) {
        if (session.endedAt || report) throw new ConflictError('Session already ended', 'native_stop_ended');
        await tx.insert(agentNativeControls).values({ sessionId, instanceId, bindingGeneration: session.bindingGeneration, status: 'ready', updatedAt: now });
        return { request_id: null, instance_id: instanceId, binding_generation: session.bindingGeneration };
      }
      if (row.instanceId !== instanceId || row.bindingGeneration !== session.bindingGeneration)
        throw new ConflictError('Native process binding changed', 'native_stop_binding_changed');
      if (report && (report.request_id !== row.requestId || !row.requestId))
        throw new ConflictError('Stop request changed', 'native_stop_request_changed');
      if (report && !['requested', 'accepted', report.status].includes(row.status))
        throw new ConflictError('Stop already settled', 'native_stop_settled');
      // A delayed acceptance must never regress an observed exit.
      const status = report?.status ?? row.status;
      const age = Date.now() - Date.parse(row.updatedAt);
      if (!report && !row.requestId && status === 'ready' && age >= 0 && age < 7_000)
        return { request_id: null, instance_id: row.instanceId, binding_generation: row.bindingGeneration };
      await tx.update(agentNativeControls).set({ status, updatedAt: now }).where(eq(agentNativeControls.sessionId, sessionId));
      return { request_id: ['requested', 'accepted'].includes(status) ? row.requestId : null, instance_id: row.instanceId, binding_generation: row.bindingGeneration };
    });
  }
  async request(sessionId: string, key: string, expected: { instance_id: string; binding_generation: number }, actor: number) {
    return this.db.transaction(async tx => {
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).for('update');
      const [row] = await tx.select().from(agentNativeControls).where(eq(agentNativeControls.sessionId, sessionId)).for('update');
      if (!session || !row) throw new NotFoundError('Native stop is unavailable');
      await assertFleetEngineEnabledForAdmin(this.db, parseEngine(session.engine));
      if (row.instanceId !== expected.instance_id || row.bindingGeneration !== expected.binding_generation || session.bindingGeneration !== expected.binding_generation)
        throw new ConflictError('Session binding changed', 'native_stop_binding_changed');
      if (row.requestId) {
        if (row.clientMessageId !== key || row.actorId !== actor) throw new ConflictError('A stop already exists', 'native_stop_in_progress');
        return { ...controlView(row)!, replayed: true };
      }
      if (session.endedAt || !controlView(row)?.available) throw new ConflictError('Refresh session status before stopping', 'native_stop_unavailable');
      if (session.agentBusAddressId) {
        const [address] = await tx.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, session.agentBusAddressId)).for('update');
        if (address?.currentSessionId !== sessionId || address.bindingGeneration !== expected.binding_generation)
          throw new ConflictError('Session binding changed', 'native_stop_binding_changed');
      }
      const [daemon] = await tx.select().from(hostDaemonPortalBindings).where(eq(hostDaemonPortalBindings.portalSessionId, sessionId));
      if (daemon) throw new ConflictError('Use the daemon session stop for this process', 'native_stop_daemon_managed');
      const now = new Date().toISOString();
      const watchdogs = await tx.select().from(agentWatchdogs).where(and(eq(agentWatchdogs.sessionId, sessionId), inArray(agentWatchdogs.status, WATCHDOG_LIVE))).for('update');
      for (const watchdog of watchdogs) await stopWatchdogLocked(tx, watchdog, 'disabled', 'user_stop', now);
      // Cancel recovery of this execution, preserving future ordinary cron ticks.
      const messages = await tx.select({ id: agentBusMessages.id }).from(agentBusMessages).where(and(eq(agentBusMessages.deliverySessionId, sessionId), inArray(agentBusMessages.status, ['accepted', 'leased']))).for('update');
      if (messages.length) await tx.update(agentScheduleRuns).set({ persistent: 0, status: 'canceled', lastError: 'user_stop', updatedAt: now }).where(inArray(agentScheduleRuns.messageId, messages.map(m => m.id)));
      const next = { ...row, requestId: randomUUID(), clientMessageId: key, actorId: actor, status: 'requested', updatedAt: now };
      await tx.update(agentNativeControls).set(next).where(eq(agentNativeControls.sessionId, sessionId));
      return { ...controlView(next)!, replayed: false };
    });
  }
}
