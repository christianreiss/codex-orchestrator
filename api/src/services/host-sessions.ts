/**
 * Fleet-wide managed-wrapper sync activity derived from the `logs` table.
 *
 * `agents.retrieve` is emitted by bootstrap and the standalone agents route,
 * so it is a sync-attempt signal, not proof that an engine process launched.
 * The API keeps the historical `sessions` response key for compatibility, but
 * wrappers label these counters as recent hosts / UTC syncs.
 *
 * Read-only and idempotent — safe to call on every bootstrap request.
 */
import { and, gte, sql } from 'drizzle-orm';
import { logs } from '../db/schema.js';
import type { Database } from '../db/client.js';

const SESSION_ACTION = 'agents.retrieve';
const NOW_WINDOW_MINUTES = 30;

export interface FleetSessionCounts {
  /** Distinct hosts that retrieved managed agents in the last 30 minutes. */
  now: number;
  /** Total managed agents retrievals since the UTC day boundary. */
  today: number;
  /** Total managed agents retrievals since the UTC month boundary. */
  month: number;
}

export class HostSessionsService {
  constructor(private readonly db: Database) {}

  async fleetCounts(now: Date = new Date()): Promise<FleetSessionCounts> {
    const nowCutoff = isoFloor(new Date(now.getTime() - NOW_WINDOW_MINUTES * 60 * 1000));
    const todayCutoff = isoFloor(startOfUtcDay(now));
    const monthCutoff = isoFloor(startOfUtcMonth(now));

    const [nowRows, todayRows, monthRows] = await Promise.all([
      // Count distinct hosts in the 30-minute window so retries from one host
      // do not inflate the recent-host signal.
      this.db
        .select({ c: sql<number>`count(distinct ${logs.hostId})` })
        .from(logs)
        .where(and(sql`${logs.action} = ${SESSION_ACTION}`, gte(logs.createdAt, nowCutoff))),
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(logs)
        .where(and(sql`${logs.action} = ${SESSION_ACTION}`, gte(logs.createdAt, todayCutoff))),
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(logs)
        .where(and(sql`${logs.action} = ${SESSION_ACTION}`, gte(logs.createdAt, monthCutoff))),
    ]);

    return {
      now: Number(nowRows[0]?.c ?? 0),
      today: Number(todayRows[0]?.c ?? 0),
      month: Number(monthRows[0]?.c ?? 0),
    };
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Match the wrapper's stored format (`nowIso` in util/timestamp.ts strips
// millis); using the unstripped form still compares correctly lexically.
function isoFloor(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
