/**
 * Fleet-wide cdx-run session counts derived from the `logs` table.
 *
 * A "session" here is one `cdx run` invocation. Every such invocation hits
 * `/sync/bootstrap`, which fans out to `HostAgentsService.retrieve()` and
 * writes one `logs` row with `action='agents.retrieve'` (see
 * `api/src/services/host-agents.ts:40,76`). Counting those rows by window
 * gives us the three fleet-wide aggregates the boot screen wants.
 *
 * Read-only and idempotent — safe to call on every bootstrap request.
 */
import { and, gte, sql } from 'drizzle-orm';
import { logs } from '../db/schema.js';
import type { Database } from '../db/client.js';

const SESSION_ACTION = 'agents.retrieve';
const NOW_WINDOW_MINUTES = 30;

export interface FleetSessionCounts {
  /** Distinct hosts that started a cdx run in the last 30 minutes — proxy for "concurrent now". */
  now: number;
  /** Total cdx-run starts across the fleet today (UTC day boundary). */
  today: number;
  /** Total cdx-run starts across the fleet this calendar month (UTC). */
  month: number;
}

export class HostSessionsService {
  constructor(private readonly db: Database) {}

  async fleetCounts(now: Date = new Date()): Promise<FleetSessionCounts> {
    const nowCutoff = isoFloor(new Date(now.getTime() - NOW_WINDOW_MINUTES * 60 * 1000));
    const todayCutoff = isoFloor(startOfUtcDay(now));
    const monthCutoff = isoFloor(startOfUtcMonth(now));

    const [nowRows, todayRows, monthRows] = await Promise.all([
      // Count *distinct* hosts in the 30-min window so a chatty host doesn't
      // inflate the "concurrent now" number to look like ten sessions.
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
