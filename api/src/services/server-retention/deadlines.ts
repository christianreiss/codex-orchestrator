import { sql, type SQL } from 'drizzle-orm';
import type { PersistenceTransaction } from '../../control-plane/persistence.js';
import type { OwnerWorkObligation } from '../../ops/owner-worker.js';
import { SERVER_RETENTION_SECONDS } from './guards.js';

const DAY = SERVER_RETENTION_SECONDS * 1000;
/** Each input is an overapproximation of a real retention branch. Eligibility
 * guards stay in the deletion command; this index never grants deletion authority. */
export const RETENTION_CLOCKS = {
  turns: [],
  credentials: [
    { table: 'mcp_session_tokens', column: 'expires_at', delay: 0 },
    { table: 'admin_sessions', column: 'expires_at', delay: 0 },
    { table: 'provider_account_sessions', column: 'expires_at', delay: 0 },
  ],
  relays: [
    { table: 'agent_bus_relays', column: 'heartbeat_at', delay: DAY },
    { table: 'agent_bus_relays', column: 'token_expires_at', delay: 0 },
  ],
  conversations: [{ table: 'agent_bus_conversations', column: 'last_activity_at', delay: DAY }],
  daemons: [{ table: 'host_daemon_sessions', column: 'last_activity_at', delay: DAY }],
  chatty: [
    { table: 'chatty_sessions', column: 'updated_at', delay: DAY },
    { table: 'chatty_runs', column: 'updated_at', delay: DAY },
    { table: 'chatty_runs', column: 'lease_until', delay: DAY },
    { table: 'chatty_events', column: 'created_at', delay: DAY },
  ],
  rooms: [
    { table: 'agent_room_events', column: 'created_at', delay: DAY },
    { table: 'agent_bus_conferences', column: 'adjourned_at', delay: DAY },
    { table: 'agent_bus_conferences', column: 'created_at', delay: DAY },
    { table: 'agent_chat_attachments', column: 'updated_at', delay: DAY },
    { table: 'agent_scope_events', column: 'created_at', delay: DAY },
    { table: 'agent_room_reads', column: 'read_at', delay: DAY },
    { table: 'agent_room_operations', column: 'created_at', delay: DAY },
  ],
  addresses: [
    { table: 'agent_bus_addresses', column: 'last_seen_at', delay: DAY },
    { table: 'agent_bus_publications', column: 'created_at', delay: DAY },
  ],
  portal: [
    { table: 'agent_sessions', column: 'expires_at', delay: 0 },
    { table: 'agent_chat_notices', column: 'created_at', delay: DAY },
  ],
  attachments: [{ table: 'agent_chat_attachments', column: 'updated_at', delay: DAY + 1 }],
} as const;
export type RetentionFamily = keyof typeof RETENTION_CLOCKS;
export const RETENTION_FAMILIES = Object.keys(RETENTION_CLOCKS) as RetentionFamily[];
export interface RetentionClockSnapshot {
  past: boolean;
  next: number | null;
}
export type RetentionClockReader = (family: RetentionFamily, now: number) => Promise<RetentionClockSnapshot>;

/** Bounded aggregate result, no bodies or unbounded history hydrated. The future
 * minimum is independent of past protected rows, which must not hide later work. */
export async function readRetentionClock(
  tx: PersistenceTransaction,
  family: RetentionFamily,
  now: number,
  workingTurnMs = 900_000,
): Promise<RetentionClockSnapshot> {
  if (family === 'turns') {
    const cutoff = new Date(now - workingTurnMs).toISOString();
    const [rows] =
      await tx.execute(sql`SELECT MAX(CASE WHEN started_at <= ${cutoff} THEN 1 ELSE 0 END) AS has_past,
      MIN(CASE WHEN started_at > ${cutoff} THEN started_at ELSE NULL END) AS next_stamp
      FROM (SELECT COALESCE((SELECT MAX(e.created_at) FROM agent_events e WHERE BINARY e.session_id = BINARY s.id AND e.event_type = 'message_accepted'), '1970-01-01T00:00:00.000Z') AS started_at
        FROM agent_sessions s WHERE s.ended_at IS NULL AND s.active_turn_id IS NOT NULL) active_turns`);
    const row = (rows as unknown as Array<{ has_past: number | null; next_stamp: string | null }>)[0];
    return {
      past: Number(row?.has_past) === 1,
      next: row?.next_stamp ? Date.parse(row.next_stamp) + workingTurnMs : null,
    };
  }
  // A protected row can become eligible merely as its latest contact ages.
  // These guard clocks prevent a parked past candidate from missing that date.
  const clocks = [
    ...RETENTION_CLOCKS[family].map((clock) => ({ ...clock, guard: false })),
    { table: 'agent_sessions', column: 'heartbeat_at', delay: DAY, guard: true },
    { table: 'agent_bus_addresses', column: 'last_seen_at', delay: DAY, guard: true },
  ];
  const queries: SQL[] = clocks.map((clock) => {
    const threshold = new Date(now - clock.delay).toISOString();
    const table = sql.identifier(clock.table),
      column = sql.identifier(clock.column);
    return sql`SELECT MAX(CASE WHEN ${column} <= ${threshold} THEN 1 ELSE 0 END) AS has_past,
      CONVERT(MIN(CASE WHEN ${column} > ${threshold} THEN ${column} ELSE NULL END) USING utf8mb4) COLLATE utf8mb4_bin AS next_stamp,
      ${clock.delay} AS delay_ms, ${clock.guard ? 1 : 0} AS is_guard FROM ${table}`;
  });
  const [rows] = await tx.execute(sql.join(queries, sql` UNION ALL `));
  let past = false,
    next: number | null = null,
    nextGuard: number | null = null;
  for (const row of rows as unknown as Array<{
    has_past: number | null;
    next_stamp: string | null;
    delay_ms: number;
    is_guard: number;
  }>) {
    const guard = Number(row.is_guard) === 1;
    if (!guard) past ||= Number(row.has_past) === 1;
    if (row.next_stamp) {
      const at = Date.parse(row.next_stamp) + Number(row.delay_ms);
      if (!Number.isFinite(at)) throw new Error(`Invalid ${family} retention timestamp`);
      if (guard) nextGuard = nextGuard === null ? at : Math.min(nextGuard, at);
      else next = next === null ? at : Math.min(next, at);
    }
  }
  if (past && nextGuard !== null) next = next === null ? nextGuard : Math.min(next, nextGuard);
  return { past, next };
}

/** Only boot and a due retention transaction may read clocks. Cold append/update
 * commands call stage() after commit (before ACK), and guard-changing commands
 * call invalidate(). A zero-change guarded pass rests until an actual input change. */
export class RetentionDeadlineIndex {
  private readonly clocks = new Map<
    RetentionFamily,
    { next: number | null; past: boolean; dirty: boolean; version: number }
  >();
  private readonly listeners = new Set<() => void>();
  private ready = false;
  async hydrate(read: RetentionClockReader, now = Date.now()): Promise<void> {
    if (this.ready) throw new Error('Retention index already hydrated');
    const values: Array<[RetentionFamily, RetentionClockSnapshot]> = [];
    for (const family of RETENTION_FAMILIES) values.push([family, await read(family, now)]);
    for (const [family, clock] of values)
      this.clocks.set(family, { ...clock, dirty: clock.past, version: 1 });
    this.ready = true;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  obligations(): OwnerWorkObligation[] {
    this.assertReady();
    return [...this.clocks].flatMap(([family, clock]) => {
      const dueAt = clock.dirty ? 0 : clock.next;
      return dueAt === null ? [] : [{ key: `history:${family}`, dueAt, revision: String(clock.version) }];
    });
  }
  stage(family: RetentionFamily, dueAt: number, now = Date.now()): void {
    this.assertReady();
    if (!Number.isFinite(dueAt)) throw new Error('Invalid cold append retention deadline');
    const clock = this.clocks.get(family)!;
    clock.next = clock.next === null ? dueAt : Math.min(clock.next, dueAt);
    if (dueAt <= now) {
      clock.past = true;
      clock.dirty = true;
    }
    clock.version++;
    this.emit();
  }
  invalidate(families: readonly RetentionFamily[] = RETENTION_FAMILIES): void {
    this.assertReady();
    let changed = false;
    for (const family of families) {
      const clock = this.clocks.get(family)!;
      if (clock.past && !clock.dirty) {
        clock.dirty = true;
        clock.version++;
        changed = true;
      }
    }
    if (changed) this.emit();
  }
  /** Read in the same legitimate retention transaction, then publish after its
   * commit. deleted/changed>0 drains another bounded batch; zero parks protected
   * past candidates while retaining the independent next future deadline. */
  publishSweep(family: RetentionFamily, value: RetentionClockSnapshot, changed: number): void {
    this.assertReady();
    const clock = this.clocks.get(family)!;
    this.clocks.set(family, { ...value, dirty: value.past && changed > 0, version: clock.version + 1 });
    this.emit();
  }
  private assertReady() {
    if (!this.ready) throw new Error('Retention deadline index must hydrate before owner readiness');
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
}
