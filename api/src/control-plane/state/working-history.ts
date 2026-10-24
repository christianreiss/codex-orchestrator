import { sql, type SQL } from 'drizzle-orm';
import type { OwnedTableName } from './catalog.js';
import type { OwnerStateDraft } from './store.js';

const CLOSED_FEEDBACK = new Set(['resolved', 'dismissed', 'duplicate']);
const TERMINAL_RUNS = new Set(['completed', 'blocked', 'dead', 'canceled']);
const LIVE_WATCHDOGS = new Set(['watching', 'recovering', 'capacity_wait']);
const feedbackLive = `(f.status NOT IN ('resolved','dismissed','duplicate') OR EXISTS (SELECT 1 FROM feedback_pipeline p WHERE BINARY p.feedback_id=BINARY f.id AND (p.next_attempt_at IS NOT NULL OR p.lease_token IS NOT NULL OR p.delivery_state='uncertain')))`;
const scheduleLive = `((s.deleted_at IS NULL AND (NOT EXISTS (SELECT 1 FROM agent_watchdogs w WHERE BINARY w.schedule_id=BINARY s.id) OR EXISTS (SELECT 1 FROM agent_watchdogs w WHERE BINARY w.schedule_id=BINARY s.id AND NOT EXISTS (SELECT 1 FROM agent_watchdogs newer WHERE newer.target_address_id=w.target_address_id AND (newer.created_at>w.created_at OR (newer.created_at=w.created_at AND newer.id>w.id)))))) OR EXISTS (SELECT 1 FROM agent_schedule_runs r WHERE BINARY r.schedule_id=BINARY s.id AND r.status NOT IN ('completed','blocked','dead','canceled')) OR EXISTS (SELECT 1 FROM agent_watchdogs w WHERE BINARY w.schedule_id=BINARY s.id AND w.status IN ('watching','recovering','capacity_wait')))`;
/** SQL boot projection and the runtime projection below deliberately use the same
 * terminal sets. Unknown outcomes are retained; no age can make them terminal. */
export function domainHistoryPredicate(name: OwnedTableName): SQL | undefined {
  switch (name) {
    case 'feedbackItems':
      return sql.raw(
        `EXISTS (SELECT 1 FROM feedback_items f WHERE f.id=feedback_items.id AND ${feedbackLive})`,
      );
    case 'feedbackPipeline':
      return sql.raw(
        `EXISTS (SELECT 1 FROM feedback_items f WHERE BINARY f.id=BINARY feedback_pipeline.feedback_id AND ${feedbackLive})`,
      );
    case 'agentSchedules':
      return sql.raw(
        `EXISTS (SELECT 1 FROM agent_schedules s WHERE s.id=agent_schedules.id AND ${scheduleLive})`,
      );
    case 'agentScheduleRuns':
      return sql.raw(
        `agent_schedule_runs.status NOT IN ('completed','blocked','dead','canceled') OR (EXISTS (SELECT 1 FROM agent_schedules s WHERE BINARY s.id=BINARY agent_schedule_runs.schedule_id AND ${scheduleLive}) AND NOT EXISTS (SELECT 1 FROM agent_schedule_runs newer WHERE newer.schedule_id=agent_schedule_runs.schedule_id AND (newer.created_at>agent_schedule_runs.created_at OR (newer.created_at=agent_schedule_runs.created_at AND newer.id>agent_schedule_runs.id))))`,
      );
    case 'agentWatchdogs':
      return sql.raw(
        `agent_watchdogs.status IN ('watching','recovering','capacity_wait') OR NOT EXISTS (SELECT 1 FROM agent_watchdogs newer WHERE newer.target_address_id=agent_watchdogs.target_address_id AND (newer.created_at>agent_watchdogs.created_at OR (newer.created_at=agent_watchdogs.created_at AND newer.id>agent_watchdogs.id))) OR EXISTS (SELECT 1 FROM agent_schedule_runs r WHERE BINARY r.schedule_id=BINARY agent_watchdogs.schedule_id AND r.status NOT IN ('completed','blocked','dead','canceled'))`,
      );
    default:
      return undefined;
  }
}
export function pruneDomainHistory(draft: OwnerStateDraft, force = false): void {
  const feedbackChanged =
    force ||
    draft.table('feedbackItems') !== draft.base.table('feedbackItems') ||
    draft.table('feedbackPipeline') !== draft.base.table('feedbackPipeline');
  if (feedbackChanged) {
    const pipelines = draft.table('feedbackPipeline');
    for (const row of draft.table('feedbackItems').all()) {
      const pipeline = pipelines.get(row.id);
      if (
        CLOSED_FEEDBACK.has(row.status) &&
        !(pipeline?.nextAttemptAt || pipeline?.leaseToken || pipeline?.deliveryState === 'uncertain')
      ) {
        draft.remove('feedbackItems', row.id);
        draft.remove('feedbackPipeline', row.id);
      }
    }
  }
  if (
    !force &&
    ['agentSchedules', 'agentScheduleRuns', 'agentWatchdogs'].every((name) => {
      const table = name as 'agentSchedules' | 'agentScheduleRuns' | 'agentWatchdogs';
      return draft.table(table) === draft.base.table(table);
    })
  )
    return;
  const runs = draft.table('agentScheduleRuns').all(),
    watchdogs = draft.table('agentWatchdogs').all();
  const latestRuns = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    const old = latestRuns.get(run.scheduleId);
    if (!old || run.createdAt > old.createdAt || (run.createdAt === old.createdAt && run.id > old.id))
      latestRuns.set(run.scheduleId, run);
  }
  const latestWatchdogs = new Map<string, (typeof watchdogs)[number]>();
  for (const row of watchdogs) {
    const old = latestWatchdogs.get(row.targetAddressId);
    if (!old || row.createdAt > old.createdAt || (row.createdAt === old.createdAt && row.id > old.id))
      latestWatchdogs.set(row.targetAddressId, row);
  }
  const retainedSchedules = new Set<string>();
  for (const row of draft.table('agentSchedules').all()) {
    if (
      (!row.deletedAt &&
        (!watchdogs.some((w) => w.scheduleId === row.id) ||
          [...latestWatchdogs.values()].some((w) => w.scheduleId === row.id))) ||
      runs.some((run) => run.scheduleId === row.id && !TERMINAL_RUNS.has(run.status)) ||
      watchdogs.some((w) => w.scheduleId === row.id && LIVE_WATCHDOGS.has(w.status))
    )
      retainedSchedules.add(row.id);
    else draft.remove('agentSchedules', row.id);
  }
  for (const row of runs)
    if (
      TERMINAL_RUNS.has(row.status) &&
      (!retainedSchedules.has(row.scheduleId) || latestRuns.get(row.scheduleId)?.id !== row.id)
    )
      draft.remove('agentScheduleRuns', row.id);
  for (const row of watchdogs)
    if (
      !LIVE_WATCHDOGS.has(row.status) &&
      latestWatchdogs.get(row.targetAddressId)?.id !== row.id &&
      !runs.some((run) => run.scheduleId === row.scheduleId && !TERMINAL_RUNS.has(run.status))
    )
      draft.remove('agentWatchdogs', row.id);
}
