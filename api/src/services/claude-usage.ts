/**
 * Claude usage service — dashboard-parity counterpart to `chatgpt-usage.ts`,
 * but PUSH instead of PULL: the server never holds or calls out with a
 * Claude OAuth token (Anthropic's Consumer ToS prohibits third-party use of
 * a Free/Pro/Max subscription's OAuth token, and there is public enforcement
 * precedent). Instead, the clx wrapper's fleet-owned statusLine command
 * captures the `rate_limits` object Claude Code itself computes and hands it
 * to the statusLine command's stdin, and reports the already-computed
 * percentages here. This service only ever stores what was reported.
 */

import { desc, eq, gte, lte, and } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { claudeUsageSnapshots } from '../db/schema.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';

type ClaudeSnapshotRow = typeof claudeUsageSnapshots.$inferSelect;
type ClaudeSnapshotInsert = typeof claudeUsageSnapshots.$inferInsert;

export interface ClaudeUsageReport {
  hostId?: number | null;
  source?: string | null;
  fiveHourUsedPercent?: number | null;
  fiveHourResetsAt?: string | null;
  sevenDayUsedPercent?: number | null;
  sevenDayResetsAt?: string | null;
}

interface ClaudeWindow {
  used_percent: number | null;
  resets_at: string | null;
}

function windowFrom(usedPercent: number | null | undefined, resetsAt: string | null | undefined): ClaudeWindow {
  return { used_percent: usedPercent ?? null, resets_at: resetsAt ?? null };
}

export function normalizeClaudeUsageSnapshot(row: ClaudeSnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    host_id: row.hostId,
    source: row.source,
    five_hour_used_percent: row.fiveHourUsedPercent,
    five_hour_resets_at: row.fiveHourResetsAt,
    seven_day_used_percent: row.sevenDayUsedPercent,
    seven_day_resets_at: row.sevenDayResetsAt,
    five_hour_window: windowFrom(row.fiveHourUsedPercent, row.fiveHourResetsAt),
    seven_day_window: windowFrom(row.sevenDayUsedPercent, row.sevenDayResetsAt),
    fetched_at: row.fetchedAt,
  };
}

function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeResetsAt(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export class ClaudeUsageService {
  constructor(private readonly db: Database) {}

  async latest(): Promise<ClaudeSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(claudeUsageSnapshots)
      .orderBy(desc(claudeUsageSnapshots.fetchedAt), desc(claudeUsageSnapshots.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Stores one reported reading. Returns null (and stores nothing) when
   * neither window carries a usable percentage — a report with nothing new
   * to say must not blank out the last known reading with an empty row.
   */
  async store(report: ClaudeUsageReport): Promise<ClaudeSnapshotRow | null> {
    const fiveHourUsedPercent = clampPercent(report.fiveHourUsedPercent);
    const sevenDayUsedPercent = clampPercent(report.sevenDayUsedPercent);
    if (fiveHourUsedPercent === null && sevenDayUsedPercent === null) {
      return null;
    }
    const now = nowIso();
    const values: ClaudeSnapshotInsert = {
      hostId: report.hostId ?? null,
      source: report.source?.trim() || 'statusline',
      fiveHourUsedPercent,
      fiveHourResetsAt: normalizeResetsAt(report.fiveHourResetsAt),
      sevenDayUsedPercent,
      sevenDayResetsAt: normalizeResetsAt(report.sevenDayResetsAt),
      fetchedAt: now,
      createdAt: now,
    };
    const result = await this.db.insert(claudeUsageSnapshots).values(values);
    const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
    if (typeof insertId === 'number' && insertId > 0) {
      const rows = await this.db
        .select()
        .from(claudeUsageSnapshots)
        .where(eq(claudeUsageSnapshots.id, insertId))
        .limit(1);
      if (rows[0]) return rows[0];
    }
    return this.latest();
  }

  async history(params: {
    days?: number;
    from?: string | null;
    until?: string | null;
  }): Promise<{
    days: number;
    from: string;
    until: string;
    series: Array<{ key: string; label: string; points: Array<{ ts: string; value: number }> }>;
  }> {
    const days = Math.max(1, Math.min(365, params.days ?? 60));
    const fromIso = params.from ?? isoOffsetSeconds(-days * 86400);
    const untilIso = params.until ?? nowIso();
    const rows = await this.db
      .select({
        fetchedAt: claudeUsageSnapshots.fetchedAt,
        fiveHourUsedPercent: claudeUsageSnapshots.fiveHourUsedPercent,
        sevenDayUsedPercent: claudeUsageSnapshots.sevenDayUsedPercent,
      })
      .from(claudeUsageSnapshots)
      .where(and(gte(claudeUsageSnapshots.fetchedAt, fromIso), lte(claudeUsageSnapshots.fetchedAt, untilIso)))
      .orderBy(claudeUsageSnapshots.fetchedAt);

    const fiveHour: Array<{ ts: string; value: number }> = [];
    const sevenDay: Array<{ ts: string; value: number }> = [];
    for (const row of rows) {
      if (typeof row.fiveHourUsedPercent === 'number') {
        fiveHour.push({ ts: row.fetchedAt, value: row.fiveHourUsedPercent });
      }
      if (typeof row.sevenDayUsedPercent === 'number') {
        sevenDay.push({ ts: row.fetchedAt, value: row.sevenDayUsedPercent });
      }
    }

    return {
      days,
      from: fromIso,
      until: untilIso,
      series: [
        { key: 'five_hour', label: '5-hour window', points: fiveHour },
        { key: 'seven_day', label: 'Weekly window', points: sevenDay },
      ],
    };
  }
}
