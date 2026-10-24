import { ownerRuntimeFor } from '../control-plane/state/runtime.js';
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
import { sql } from 'drizzle-orm';
import { logs } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { isoOffsetSeconds } from '../util/timestamp.js';

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
  constructor(private readonly db: Pick<Database, 'execute'>) {}

  async fleetCounts(now: Date = new Date()): Promise<FleetSessionCounts> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner();
      return { now: 0, today: 0, month: 0 };
    }
    // Legacy fixtures retain the historical aggregate contract. Production no
    // longer collects agents.retrieve (migration 0092); zeros are compatibility
    // placeholders, never a measurement of active connections or native work.
    const nowCutoff = isoFloor(new Date(now.getTime() - NOW_WINDOW_MINUTES * 60 * 1000));
    const todayCutoff = isoFloor(startOfUtcDay(now));
    const monthCutoff = isoFloor(startOfUtcMonth(now));

    // One round trip/connection, with separate covering-index ranges. A single
    // conditional aggregate would feed the whole month's rows into DISTINCT;
    // this keeps that work bounded to recent hosts and preserves the previous
    // month's part of the recent window just after UTC midnight on the 1st.
    // Server-owned hosts (the Fleet Advisor) are not fleet sessions.
    const fleetHost = sql`${logs.hostId} NOT IN (SELECT id FROM hosts WHERE internal_role IS NOT NULL)`;
    const [result] = await this.db.execute(sql`
      SELECT
        (SELECT count(distinct ${logs.hostId}) FROM ${logs}
          WHERE ${logs.action} = ${SESSION_ACTION} AND ${logs.createdAt} >= ${nowCutoff} AND ${fleetHost}) AS recent,
        (SELECT count(*) FROM ${logs}
          WHERE ${logs.action} = ${SESSION_ACTION} AND ${logs.createdAt} >= ${todayCutoff} AND ${fleetHost}) AS today,
        (SELECT count(*) FROM ${logs}
          WHERE ${logs.action} = ${SESSION_ACTION} AND ${logs.createdAt} >= ${monthCutoff} AND ${fleetHost}) AS month
    `);
    // Drizzle's mysql2 raw executor types every result as a write header.
    const rows = result as unknown as Array<{
      recent: number | string;
      today: number | string;
      month: number | string;
    }>;
    return {
      now: Number(rows[0]?.recent ?? 0),
      today: Number(rows[0]?.today ?? 0),
      month: Number(rows[0]?.month ?? 0),
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
  return isoOffsetSeconds(0, d);
}
