import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentWatchdogs,
  agentSchedules,
  agentScheduleRuns,
  agentBusMessages,
  agentBusAddresses,
  type AgentSession,
} from '../db/schema.js';

// The caller owns the transaction; ordinary Wake/Cron schedules are never touched.
type WatchdogDb = Pick<Database, 'select' | 'update'>;
export const WATCHDOG_LIVE = ['watching', 'recovering', 'capacity_wait'];
export const WATCHDOG_FAILURES = ['capacity', 'crash', 'hang', 'user_stop', 'blocked'] as const;
export type WatchdogFailure = (typeof WATCHDOG_FAILURES)[number];

export function watchdogRetryTime(now: Date, providerHint?: string) {
  const hint = providerHint ? Date.parse(providerHint) : NaN;
  return new Date(
    Math.max(now.getTime() + 300000 * (1 + Math.random() * 0.2), Number.isFinite(hint) ? hint : 0),
  ).toISOString();
}

export async function stopWatchdogLocked(
  tx: WatchdogDb,
  row: typeof agentWatchdogs.$inferSelect,
  status: string,
  reason: string,
  now: string,
) {
  await tx
    .update(agentWatchdogs)
    .set({ status, lastError: reason, version: row.version + 1, updatedAt: now })
    .where(eq(agentWatchdogs.id, row.id));
  await tx
    .update(agentSchedules)
    .set({
      enabled: 0,
      nextDueAt: null,
      pauseReason: reason,
      version: sql`${agentSchedules.version} + 1`,
      updatedAt: now,
    })
    .where(eq(agentSchedules.id, row.scheduleId));
  const runs = await tx
    .select()
    .from(agentScheduleRuns)
    .where(eq(agentScheduleRuns.scheduleId, row.scheduleId));
  for (const run of runs) {
    const [message] = run.messageId
      ? await tx.select().from(agentBusMessages).where(eq(agentBusMessages.id, run.messageId)).for('update')
      : [];
    // Durable acceptance can precede the next schedule tick. Preserve that work.
    if (message?.status === 'accepted' || run.status === 'accepted' || run.status === 'completed') continue;
    if (message && ['queued', 'leased'].includes(message.status))
      await tx
        .update(agentBusMessages)
        .set({ status: 'canceled', canceledAt: now, leaseOwner: null, leaseUntil: null, updatedAt: now })
        .where(eq(agentBusMessages.id, message.id));
    await tx
      .update(agentScheduleRuns)
      .set({ status: 'canceled', updatedAt: now })
      .where(eq(agentScheduleRuns.id, run.id));
  }
}

/** Finalize the bound watchdog before the session loses its current binding. */
export async function finishSessionWatchdogsLocked(
  tx: WatchdogDb,
  session: AgentSession,
  status: 'completed' | 'failed',
  failure: WatchdogFailure | undefined,
  now: string,
) {
  // Worker transport completion is not a task outcome. Its durable delivery ACK
  // owns recovery, even when the native command returns zero.
  if (session.invocationKind === 'peer_delivery' || !session.agentBusAddressId || !session.upstreamSessionId)
    return;
  const [target] = await tx
    .select()
    .from(agentBusAddresses)
    .where(eq(agentBusAddresses.id, session.agentBusAddressId))
    .for('update');
  if (
    !target ||
    target.currentSessionId !== session.id ||
    target.lastUpstreamSessionId !== session.upstreamSessionId ||
    target.bindingGeneration !== session.bindingGeneration
  )
    return;
  const rows = await tx
    .select()
    .from(agentWatchdogs)
    .where(
      and(
        eq(agentWatchdogs.targetAddressId, target.id),
        eq(agentWatchdogs.nativeSessionId, session.upstreamSessionId),
        inArray(agentWatchdogs.status, WATCHDOG_LIVE),
      ),
    )
    .for('update');
  const cause = failure ?? (status === 'completed' ? 'user_stop' : 'crash');
  for (const row of rows) {
    if (row.deadlineAt <= now) {
      await stopWatchdogLocked(tx, row, 'expired', 'deadline', now);
    } else if (cause === 'user_stop' || cause === 'blocked') {
      await stopWatchdogLocked(
        tx,
        row,
        cause === 'user_stop' ? 'disabled' : 'blocked',
        cause === 'user_stop' ? 'user_stop' : 'provider_error',
        now,
      );
    } else if (row.status === 'watching') {
      const at = watchdogRetryTime(new Date(now));
      await tx
        .update(agentWatchdogs)
        .set({
          status: cause === 'capacity' ? 'capacity_wait' : 'recovering',
          lastError: cause,
          updatedAt: now,
        })
        .where(eq(agentWatchdogs.id, row.id));
      await tx
        .update(agentSchedules)
        .set({ atTime: at, nextDueAt: at, updatedAt: now })
        .where(eq(agentSchedules.id, row.scheduleId));
    }
  }
}
