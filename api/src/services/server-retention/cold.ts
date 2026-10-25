import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceTransaction } from '../../control-plane/persistence.js';
import type { OwnerMutationContext } from '../../control-plane/state/runtime.js';
import { workingSetPredicate } from '../../control-plane/state/catalog.js';
import { INTERNAL_RECEIPT_DAYS, RECEIPT_RESULT_DAYS, type ServerRetentionPolicy } from './policy.js';

export const COLD_FAMILIES = ['auditlogs', 'adminaudit', 'quota', 'receipts'] as const;
export type ColdFamily = (typeof COLD_FAMILIES)[number];
export const isColdFamily = (family: string): family is ColdFamily =>
  (COLD_FAMILIES as readonly string[]).includes(family);
interface ColdTask {
  table: string;
  column: string;
  delay: number;
  owned?: 'chatgptUsageSnapshots' | 'claudeUsageSnapshots';
  guard: SQL;
  clockGuard?: SQL;
  action?: 'expire';
}
const DAY = 86_400_000;
const validStamp = (column: string) =>
  sql`${sql.identifier(column)} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+]00:00)$'`;
export function coldTasks(family: ColdFamily, p: ServerRetentionPolicy): ColdTask[] {
  if (!p.armed) return [];
  if (family === 'auditlogs' || family === 'adminaudit')
    return [
      {
        table: family === 'auditlogs' ? 'logs' : 'admin_events',
        column: 'created_at',
        delay: p.audit_days * DAY,
        guard: sql`1=1`,
      },
    ];
  if (family === 'quota')
    return [
      ...(['chatgptUsageSnapshots', 'claudeUsageSnapshots'] as const).map((name) => ({
        owned: name,
        table: name === 'chatgptUsageSnapshots' ? 'chatgpt_usage_snapshots' : 'claude_usage_snapshots',
        column: 'fetched_at',
        delay: p.quota_days * DAY,
        guard: sql`NOT (${workingSetPredicate(name)!})`,
      })),
      ...['dashboard_graph_quota_snapshots', 'dashboard_graph_claude_quota_snapshots'].map((table) => ({
        table,
        column: table === 'dashboard_graph_claude_quota_snapshots' ? 'snapshot_at' : 'fetched_at',
        delay: p.quota_days * DAY,
        guard: sql`1=1`,
      })),
    ];
  const free = sql`NOT EXISTS (SELECT 1 FROM control_plane_outbox o WHERE BINARY o.principal=BINARY control_plane_command_receipts.principal AND BINARY o.request_id=BINARY control_plane_command_receipts.request_id AND o.completed_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM chatty_actions a WHERE BINARY a.id=BINARY control_plane_command_receipts.request_id AND a.status IN ('executing','unknown'))
    AND NOT EXISTS (SELECT 1 FROM agent_bus_messages m WHERE (BINARY m.client_message_id=BINARY control_plane_command_receipts.request_id OR BINARY m.claim_id=BINARY control_plane_command_receipts.request_id) AND (m.status IN ('queued','leased','accepted','reboot_hold','batched','ambiguous') OR m.task_result_status='unknown'))
    AND NOT EXISTS (SELECT 1 FROM agent_messages m WHERE BINARY m.client_message_id=BINARY control_plane_command_receipts.request_id AND m.status IN ('queued','leased','accepted','reboot_hold','ambiguous'))`;
  return [
    {
      table: 'control_plane_command_receipts',
      column: 'created_at',
      delay: INTERNAL_RECEIPT_DAYS * DAY,
      clockGuard: sql`replay_class='internal'`,
      guard: sql`replay_class='internal' AND (${free})`,
    },
    {
      table: 'control_plane_command_receipts',
      column: 'created_at',
      delay: RECEIPT_RESULT_DAYS * DAY,
      clockGuard: sql`replay_class<>'internal' AND result_state='available'`,
      guard: sql`replay_class<>'internal' AND result_state='available' AND (${free})`,
      action: 'expire',
    },
  ];
}
export async function coldClock(
  tx: PersistenceTransaction,
  family: ColdFamily,
  now: number,
  policy: ServerRetentionPolicy,
) {
  let past = false,
    next: number | null = null;
  for (const task of coldTasks(family, policy)) {
    const cutoff = new Date(now - task.delay).toISOString();
    const base = sql`(${task.clockGuard ?? sql`1=1`}) AND (${validStamp(task.column)})`;
    const [old] = await tx.execute(
      sql`SELECT ${sql.identifier(task.column)} AS at FROM ${sql.identifier(task.table)} WHERE ${base} AND ${sql.identifier(task.column)}<=${cutoff} ORDER BY ${sql.identifier(task.column)} LIMIT 1`,
    );
    past ||= (old as unknown as unknown[]).length > 0;
    const [future] = await tx.execute(
      sql`SELECT ${sql.identifier(task.column)} AS at FROM ${sql.identifier(task.table)} WHERE ${base} AND ${sql.identifier(task.column)}>${cutoff} ORDER BY ${sql.identifier(task.column)} LIMIT 1`,
    );
    const at = (future as unknown as Array<{ at: string | null }>)[0]?.at;
    if (at) {
      const parsed = Date.parse(at);
      if (!Number.isFinite(parsed)) continue;
      // Keep the indexed text predicates unchanged. Alternate accepted UTC
      // forms (short/long fractions or +00:00) need not sort like their
      // millisecond ISO instant under MySQL's timestamp column collation.
      // The next second is selectable for every form, at most 1s later. Exact
      // canonical ...mmmZ deadlines keep their existing precision.
      const selectable =
        at !== new Date(parsed).toISOString() ? Math.floor(parsed / 1000) * 1000 + 1000 : parsed;
      const deadline = selectable + task.delay;
      // A SQL-future observation must name a future obligation, including a
      // conservative rearm if another accepted text form crosses this boundary.
      const due = deadline > now ? deadline : Math.floor(now / 1000) * 1000 + 1000;
      next = next === null ? due : Math.min(next, due);
    }
  }
  return { past, next };
}
export async function coldPreview(
  tx: PersistenceTransaction,
  policy: ServerRetentionPolicy,
  now = Date.now(),
) {
  const result: Record<string, { eligible: number; retained: number }> = {};
  for (const family of COLD_FAMILIES) {
    const summary = (result[family] = { eligible: 0, retained: 0 });
    for (const task of coldTasks(family, { ...policy, armed: true })) {
      const cutoff = new Date(now - task.delay).toISOString();
      const [raw] = await tx.execute(
        sql`SELECT COUNT(*) AS total, COALESCE(SUM(${sql.identifier(task.column)}<=${cutoff} AND (${task.guard}) AND (${validStamp(task.column)})),0) AS eligible FROM ${sql.identifier(task.table)} WHERE ${task.clockGuard ?? sql`1=1`}`,
      );
      const row = (raw as unknown as Array<{ total: number; eligible: number }>)[0];
      summary.eligible += Number(row?.eligible ?? 0);
      summary.retained += Number(row?.total ?? 0) - Number(row?.eligible ?? 0);
    }
  }
  return result;
}
/** Same predicates as preview/clocks. One bounded primary-record batch. */
export async function purgeCold(
  context: OwnerMutationContext,
  tx: PersistenceTransaction,
  family: ColdFamily,
  p: ServerRetentionPolicy,
  now = Date.now(),
): Promise<number> {
  for (const task of coldTasks(family, p)) {
    const receipt = task.table === 'control_plane_command_receipts';
    const cutoff = new Date(now - task.delay).toISOString();
    // Current guards belong to the owner. Cold SQL only locates aged history.
    let guard = task.guard;
    if (receipt) {
      const pending = new Set<string>();
      for (const o of context.snapshot.table('controlPlaneOutbox').all())
        if (!o.completedAt) pending.add(o.requestId);
      for (const a of context.snapshot.table('chattyActions').all())
        if (['executing', 'unknown'].includes(a.status)) pending.add(a.id);
      for (const m of context.snapshot.messages.all())
        if (
          ['queued', 'leased', 'accepted', 'reboot_hold', 'batched', 'ambiguous'].includes(m.status) ||
          m.taskResultStatus === 'unknown'
        ) {
          if (m.clientMessageId) pending.add(m.clientMessageId);
          if (m.claimId) pending.add(m.claimId);
        }
      for (const m of context.snapshot.table('agentMessages').all())
        if (
          ['queued', 'leased', 'accepted', 'reboot_hold', 'ambiguous'].includes(m.status) &&
          m.clientMessageId
        )
          pending.add(m.clientMessageId);
      guard = sql`${task.clockGuard!} ${
        pending.size
          ? sql`AND request_id NOT IN (${sql.join(
              [...pending].map((id) => sql`${id}`),
              sql`,`,
            )})`
          : sql``
      }`;
    } else if (task.owned) {
      const retained = context.snapshot
        .table(task.owned)
        .all()
        .map((row) => row.id);
      guard = retained.length
        ? sql`id NOT IN (${sql.join(
            retained.map((id) => sql`${id}`),
            sql`,`,
          )})`
        : sql`1=1`;
    }
    const [raw] = await tx.execute(
      sql`SELECT ${receipt ? sql`principal,request_id` : sql`id`},${sql.identifier(task.column)} AS at FROM ${sql.identifier(task.table)} WHERE ${sql.identifier(task.column)}<=${cutoff} AND (${validStamp(task.column)}) AND (${guard}) ORDER BY ${sql.identifier(task.column)} LIMIT 100 FOR UPDATE`,
    );
    const candidates = (
      raw as unknown as Array<{ id: number; principal: string; request_id: string; at: string }>
    ).filter((row) => Number.isFinite(Date.parse(row.at)) && Date.parse(row.at) + task.delay <= now);
    if (!candidates.length) continue;
    if (family === 'auditlogs' || family === 'adminaudit') {
      for (const key of [
        'owner_engine_actor_codex',
        'owner_engine_actor_claude',
        'owner_engine_actor_grok',
        'owner_admin_event_id',
      ]) {
        const row = context.draft.table('versions').get(key);
        if (row)
          await tx.execute(
            sql`INSERT INTO versions(name,version,updated_at) VALUES (${row.name},${row.version},${row.updatedAt}) ON DUPLICATE KEY UPDATE version=VALUES(version),updated_at=VALUES(updated_at)`,
          );
      }
    }
    const match = receipt
      ? sql.join(
          candidates.map(
            (row) =>
              sql`(BINARY principal=BINARY ${row.principal} AND BINARY request_id=BINARY ${row.request_id})`,
          ),
          sql` OR `,
        )
      : sql`id IN (${sql.join(
          candidates.map((row) => sql`${row.id}`),
          sql`,`,
        )})`;
    if (task.action === 'expire')
      await tx.execute(
        sql`UPDATE control_plane_command_receipts SET result_enc=NULL,result_state='expired' WHERE ${match}`,
      );
    else await tx.execute(sql`DELETE FROM ${sql.identifier(task.table)} WHERE ${match}`);
    if (task.owned) for (const row of candidates) context.draft.remove(task.owned, Number(row.id));
    if (family === 'auditlogs') {
      const [latest] = await tx.execute(sql`SELECT MAX(created_at) AS at FROM logs`);
      context.draft.upsert('versions', {
        name: 'owner_latest_log_at',
        version: (latest as unknown as Array<{ at: string | null }>)[0]?.at ?? '',
        updatedAt: new Date(now).toISOString(),
      });
    }
    // The raw-provider rows selected into RAM were explicitly excluded above.
    return candidates.length;
  }
  return 0;
}
