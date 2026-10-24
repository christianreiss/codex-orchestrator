import { createHash } from 'node:crypto';
import type { EntityView, OwnerStateSnapshot } from '../control-plane/state/store.js';
import type { OwnedTableName } from '../control-plane/state/catalog.js';
import type { OwnerWorkObligation } from './owner-worker.js';
import { SCHEDULE_TARGET_GRACE_SECONDS } from '../services/schedules/staleness.js';

export const SCHEDULE_TABLES = [
  'versions',
  'hosts',
  'hostDaemons',
  'agentSchedules',
  'agentScheduleRuns',
  'agentWatchdogs',
  'agentBusAddresses',
  'agentSessions',
  'agentBusMessages',
  'agentPrompts',
  'providerAccounts',
  'chatgptUsageSnapshots',
  'claudeUsageSnapshots',
  'grokUsageSnapshots',
] as const satisfies readonly OwnedTableName[];
const active = new Set(['waiting', 'queued', 'leased', 'accepted', 'recovering', 'capacity_wait']);
const dependencyViewTokens = new WeakMap<EntityView<OwnedTableName>, string>();
let nextDependencyViewToken = 0n;
/** Views are immutable and reused across commits until their table changes.
 * These process-local tokens are invalidation hints, not content digests. Include
 * the owner epoch so durable command IDs derived from them cannot replay a prior
 * owner's result after restart. An identical replacement may conservatively wake
 * work again; unrelated table commits do not change its dependency revision. */
export function dependencyRevision(snapshot: OwnerStateSnapshot, tables: readonly OwnedTableName[]): string {
  const tokens = tables.map((table) => {
    const view = snapshot.table(table);
    let token = dependencyViewTokens.get(view);
    if (token === undefined) {
      token = (++nextDependencyViewToken).toString(10);
      dependencyViewTokens.set(view, token);
    }
    return [table, token];
  });
  return createHash('sha256')
    .update(JSON.stringify([snapshot.revision.epoch, tokens]))
    .digest('hex');
}
/** Input changes and business deadlines are separate obligations: observing an input
 * never suppresses its later deadline. Domain handlers must avoid no-op writes. */
export function scheduleObligations(
  snapshot: OwnerStateSnapshot,
  presenceRevision = '',
): OwnerWorkObligation[] {
  const revision = `${dependencyRevision(snapshot, SCHEDULE_TABLES)}:${presenceRevision}`;
  const result: OwnerWorkObligation[] = [];
  const add = (key: string, value: string | null | undefined, delay = 0) => {
    const dueAt = value ? Date.parse(value) + delay : NaN;
    if (Number.isFinite(dueAt)) result.push({ key, dueAt, revision });
  };
  for (const schedule of snapshot.table('agentSchedules').all()) {
    if (schedule.deletedAt) continue;
    const runs = snapshot
      .table('agentScheduleRuns')
      .all()
      .filter((run) => run.scheduleId === schedule.id);
    const liveRuns = runs.filter((run) => active.has(run.status));
    if (schedule.enabled || liveRuns.length) result.push({ key: `input:${schedule.id}`, dueAt: 0, revision });
    if (schedule.enabled && !liveRuns.length) add(`due:${schedule.id}`, schedule.nextDueAt);
    for (const run of liveRuns) {
      if (['waiting', 'recovering', 'capacity_wait'].includes(run.status))
        add(`retry:${run.id}`, run.nextAttemptAt);
    }
    if (
      snapshot
        .table('agentWatchdogs')
        .all()
        .some((row) => row.scheduleId === schedule.id)
    )
      continue;
    const grace = SCHEDULE_TARGET_GRACE_SECONDS * 1000;
    if (schedule.kind === 'once' && schedule.nextDueAt === null && !liveRuns.length) {
      const last =
        runs
          .map((row) => row.updatedAt)
          .sort()
          .at(-1) ?? schedule.updatedAt;
      add(`retire:${schedule.id}`, last, grace);
    }
    const target = snapshot.addresses.get(schedule.targetAddressId);
    if (!schedule.enabled || (schedule.persistent && target && !target.archivedAt)) continue;
    const session = target?.currentSessionId ? snapshot.sessions.get(target.currentSessionId) : undefined;
    const since = !target
      ? new Date(0).toISOString()
      : (target.archivedAt ??
        (session?.endedAt
          ? [session.endedAt, target.lastSeenAt].sort().at(-1)!
          : session
            ? null
            : target.lastSeenAt));
    add(`gone:${schedule.id}`, since, grace);
  }
  return result;
}
export function watchdogObligations(
  snapshot: OwnerStateSnapshot,
  _sessionConnected: (id: string, binding: number) => boolean,
  presenceRevision: string,
): OwnerWorkObligation[] {
  const revision = `${dependencyRevision(snapshot, SCHEDULE_TABLES)}:${presenceRevision}`;
  return snapshot
    .table('agentWatchdogs')
    .all()
    .filter((row) => ['watching', 'recovering', 'capacity_wait'].includes(row.status))
    .flatMap((row) => {
      const result = [
        { key: `input:${row.id}`, dueAt: 0, revision },
        { key: `deadline:${row.id}`, dueAt: Date.parse(row.deadlineAt), revision },
      ];
      // Socket silence is uncertainty, never proof authorizing another native execution.
      return result;
    });
}
