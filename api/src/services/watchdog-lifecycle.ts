import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
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

/**
 * A quota recovery that continues the failed turn on another account of the
 * pool. It differs from every other watchdog in what it must not do: the
 * session is alive and idle, so it is neither terminated nor timed for
 * progress, and its one continuation goes into the running session once the
 * live switch is committed. One per failed turn (the task key carries the
 * time of the failure).
 */
export const QUOTA_SWITCH_TASK = 'quota-switch:';
export const quotaSwitchWatchdog = (row: { taskKey?: string | null; createdBy?: string | null }): boolean =>
  !!row.taskKey?.startsWith(QUOTA_SWITCH_TASK) && !!row.createdBy?.startsWith('quota:');
/** How soon after the failure the recovery first looks whether the session has moved. */
export const QUOTA_SWITCH_FIRST_CHECK_MS = 10_000;
/** The failed turn's own idle report may arrive this long after the failure report. */
export const QUOTA_CONTINUE_GRACE_MS = 15_000;
const QUOTA_SWITCH_ACCOUNT = '{{account}}';
export const QUOTA_SWITCH_CONTINUATION =
  'The previous turn failed on a provider quota limit and now continues on ' +
  QUOTA_SWITCH_ACCOUNT +
  '. Continue where you left off; check quota_get before heavy work; do not invent new work. Quota figures now refer to that account (account_status shows the pool). If that task is already finished or was canceled, say so and stop.';
/** The continuation as delivered: it names the account the session runs on now. */
export function quotaSwitchContinuation(content: string, account: { id: number | null; label: string | null }): string {
  const name =
    account.id === null
      ? 'another account of the pool'
      : account.label
        ? 'account ' + account.label + ' (#' + account.id + ')'
        : 'account #' + account.id;
  return content.replace(QUOTA_SWITCH_ACCOUNT, name);
}
/** As `CLAUDE_ACTIVE_STALE_MS`: an `active` proof this old no longer says a turn runs. */
const QUOTA_CONTINUE_ACTIVE_STALE_MS = 10 * 60_000;
/**
 * Whether the failed turn is still the newest thing that happened in the
 * session. A turn that began after the failure (a typed prompt, a delivered
 * message) makes the continuation an interruption of work it knows nothing
 * about, so it is dropped; a turn that is still running defers it.
 *
 * The native turn proof decides where the session reports one: it advances only
 * with lifecycle events of the native CLI, so `active` or a finished `idle`
 * observed after the failure is a new turn. `unknown` is what the failed turn
 * itself leaves behind, and what a reconnect or an owner restart resets the
 * proof to; neither is a turn. Without a proof the activity state stands in,
 * and there too `unknown` (hook evidence older than 45 seconds) is no turn.
 */
export function quotaContinueFence(
  session: { activity?: unknown; endedAt?: string | null } | null | undefined,
  armedAt: string,
  now = Date.now(),
): 'clear' | 'busy' | 'superseded' {
  const record =
    session && !session.endedAt
      ? (session.activity as {
          state?: unknown;
          changed_at?: unknown;
          turn_proof?: { state?: unknown; observed_at_ms?: unknown } | null;
        } | null)
      : null;
  if (!record || typeof record !== 'object') return 'clear';
  const limit = Date.parse(armedAt) + QUOTA_CONTINUE_GRACE_MS;
  const proof = record.turn_proof;
  if (proof && typeof proof === 'object' && typeof proof.state === 'string') {
    const observed = typeof proof.observed_at_ms === 'number' ? proof.observed_at_ms : 0;
    if (proof.state === 'active')
      return observed > limit ? 'superseded' : now - observed < QUOTA_CONTINUE_ACTIVE_STALE_MS ? 'busy' : 'clear';
    return proof.state === 'idle' && observed > limit ? 'superseded' : 'clear';
  }
  const changed = typeof record.changed_at === 'string' ? Date.parse(record.changed_at) : NaN;
  const later = Number.isFinite(changed) && changed > limit;
  if (record.state === 'working' || record.state === 'waiting') return later ? 'superseded' : 'busy';
  return record.state === 'idle' && later ? 'superseded' : 'clear';
}

/**
 * Addresses whose session waits for its continuation on another account. That
 * continuation names the new account itself, so the separate switch notice is
 * left out for them: delivered first, it would start a turn of its own and the
 * failed turn would no longer be the newest activity.
 */
export async function quotaContinuationPending(db: Database, addressIds: string[]): Promise<Set<string>> {
  if (!addressIds.length) return new Set();
  const owner = ownerRuntimeFor(db);
  owner?.assertOwner();
  const rows = owner
    ? addressIds.flatMap((id) => owner.state.snapshot().table('agentWatchdogs').by('targetAddressId', id))
    : await db.select().from(agentWatchdogs).where(inArray(agentWatchdogs.targetAddressId, addressIds));
  return new Set(rows.filter((row) => WATCHDOG_LIVE.includes(row.status) && quotaSwitchWatchdog(row)).map((row) => row.targetAddressId));
}

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
