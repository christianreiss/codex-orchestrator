import { stageEmulation, recordEmulation } from './quota-emulation.js';
import { sameQuotaObservation, stageClaudeQuota } from '../control-plane/state/quota.js';
/**
 * Claude usage service — dashboard-parity counterpart to `chatgpt-usage.ts`,
 * but PUSH instead of PULL: the server never holds or calls out with a
 * Claude OAuth token (Anthropic's Consumer ToS prohibits third-party use of
 * a Free/Pro/Max subscription's OAuth token, and there is public enforcement
 * precedent). Instead, the clx wrapper's fleet-owned statusLine command
 * captures the `rate_limits` object Claude Code itself computes and hands it
 * to the statusLine command's stdin, and reports the already-computed
 * percentages here. This service only ever stores what was reported.
 * The single deliberate exception is `claude-identity.ts`: one OAuth profile
 * lookup per new access token so two subscriptions are not merged into one
 * account (operator decision, 2026-11-26). It never refreshes, polls usage or
 * runs inference.
 */

import { desc, eq, gte, lte, and, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { claudeUsageSnapshots } from '../db/schema.js';
import { isoOffsetSeconds, nowIso } from '../util/timestamp.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';

type ClaudeSnapshotRow = typeof claudeUsageSnapshots.$inferSelect;
type ClaudeSnapshotInsert = typeof claudeUsageSnapshots.$inferInsert;

export interface ClaudeUsageReport {
  accountId?: number;
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

function windowFrom(
  usedPercent: number | null | undefined,
  resetsAt: string | null | undefined,
): ClaudeWindow {
  return { used_percent: usedPercent ?? null, resets_at: resetsAt ?? null };
}

export function normalizeClaudeUsageSnapshot(row: ClaudeSnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    host_id: row.hostId,
    account_id: row.accountId ?? null,
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

export const CLAUDE_SHORT_WINDOW_MS = 5 * 3_600_000;
export const CLAUDE_WEEKLY_WINDOW_MS = 7 * 86_400_000;
/** Clock difference tolerated between this server and the provider's reset time. */
const RESET_SLACK_MS = 10 * 60_000;

export interface ReportedClaudeWindow {
  usedPercent: number;
  resetsAt: string | null;
}

/**
 * One window of a host's usage report, or null when it says nothing usable
 * about the window that is running now. A host only relays what Claude Code
 * displayed, so the reading is bounded by what the window allows: a share of
 * 0..100 and a reset that lies ahead by no more than the window's length. A
 * reset that already passed belongs to a window that ended; a session that
 * has been idle since keeps displaying it, and filing it again would present
 * the old figure as a fresh one.
 */
export function reportedClaudeWindow(raw: unknown, spanMs: number, now: number): ReportedClaudeWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { used_percent: used, resets_at: reset } = raw as Record<string, unknown>;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  let resetsAt: string | null = null;
  if (typeof reset === 'string' && reset.trim() !== '') {
    const at = Date.parse(reset);
    if (!Number.isFinite(at) || at <= now || at > now + spanMs + RESET_SLACK_MS) return null;
    resetsAt = reset.trim();
  } else if (reset !== undefined && reset !== null && reset !== '') {
    return null;
  }
  return { usedPercent: Math.min(100, used), resetsAt };
}

/** How long a stored share holds against lower reports for the same window while nothing reports it again. */
export const CLAUDE_READING_HOLD_MS = 60 * 60_000;
/** Two reset times this close name the same window. */
export const SAME_RESET_MS = 60_000;

interface StoredWindow {
  percent: number | null;
  resetsAt: string | null;
}

/**
 * When the stored share of an account's window was last actually reported.
 * Kept in memory only. After a restart the stored row's own time stands in
 * once: a held report also writes a row, so reading that time again on every
 * report would renew the hold for as long as lower reports keep arriving.
 */
const confirmations = new Map<string, { reset: number; percent: number; at: number }>();

/**
 * Merges one reported window into the account's stored one. Several sessions
 * report for one account and each relays the figure of its own last response,
 * so the last writer is often not the latest reading:
 *
 * - Within one window (same reset) usage only grows. A lower report is an
 *   older one and the stored share stays, for as long as some session reported
 *   that share within `CLAUDE_READING_HOLD_MS`. After that the stored share is
 *   unconfirmed and the lower report replaces it, so one wrong high reading
 *   (another account's figure filed here, an account sharing the reset time)
 *   cannot block the account for the rest of the window.
 * - A report that carries no reading for this window leaves a stored, still
 *   running window in place instead of blanking it.
 * - A different reset is a different window and replaces the stored one. Two
 *   resets that both lie ahead cannot be ordered: an account's windows do not
 *   overlap, so the later reset is not evidence of being newer.
 */
/** Drops what this process remembers about confirmations, as a restart does. */
export function forgetClaudeReadingConfirmations(): void {
  confirmations.clear();
}

function mergeWindow(
  key: string,
  reported: StoredWindow,
  prior: (StoredWindow & { fetchedAt: string }) | null,
  now: number,
): StoredWindow {
  const priorReset = prior?.percent != null && prior.resetsAt ? Date.parse(prior.resetsAt) : NaN;
  const running = prior !== null && Number.isFinite(priorReset) && priorReset > now;
  if (reported.percent === null) {
    return running ? { percent: prior.percent, resetsAt: prior.resetsAt } : { percent: null, resetsAt: null };
  }
  const reset = reported.resetsAt ? Date.parse(reported.resetsAt) : NaN;
  if (running && Number.isFinite(reset) && Math.abs(reset - priorReset) < SAME_RESET_MS) {
    const stored = prior.percent as number;
    let seen = confirmations.get(key);
    if (!seen || seen.reset !== priorReset || seen.percent !== stored) {
      seen = { reset: priorReset, percent: stored, at: Date.parse(prior.fetchedAt) };
      confirmations.set(key, seen);
    }
    if (reported.percent < stored && now - seen.at <= CLAUDE_READING_HOLD_MS) {
      return { percent: stored, resetsAt: prior.resetsAt };
    }
    confirmations.set(key, { reset: priorReset, percent: reported.percent, at: now });
    return { percent: reported.percent, resetsAt: prior.resetsAt };
  }
  if (Number.isFinite(reset)) confirmations.set(key, { reset, percent: reported.percent, at: now });
  else confirmations.delete(key);
  return reported;
}

export class ClaudeUsageService {
  constructor(
    private readonly db: Database,
    private readonly accountId?: number,
  ) {}

  async latest(): Promise<ClaudeSnapshotRow | null> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      owner.assertOwner();
      return (
        owner.state
          .snapshot()
          .table('claudeUsageSnapshots')
          .all()
          .filter((row) => row.accountId === (this.accountId ?? null))
          .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id)[0] ?? null
      );
    }
    const rows = await this.db
      .select()
      .from(claudeUsageSnapshots)
      .where(
        this.accountId === undefined
          ? isNull(claudeUsageSnapshots.accountId)
          : eq(claudeUsageSnapshots.accountId, this.accountId),
      )
      .orderBy(desc(claudeUsageSnapshots.fetchedAt), desc(claudeUsageSnapshots.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Stores one reported reading. Returns null (and stores nothing) when
   * neither window carries a usable percentage — a report with nothing new
   * to say must not blank out the last known reading with an empty row.
   * Each window is merged with the account's stored one (`mergeWindow`), so
   * the row written is the account's reading, not just this reporter's.
   */
  async store(report: ClaudeUsageReport, at: number = Date.now()): Promise<ClaudeSnapshotRow | null> {
    const fiveHourUsedPercent = clampPercent(report.fiveHourUsedPercent);
    const sevenDayUsedPercent = clampPercent(report.sevenDayUsedPercent);
    if (fiveHourUsedPercent === null && sevenDayUsedPercent === null) {
      return null;
    }
    const now = isoOffsetSeconds(0, new Date(at));
    const values: ClaudeSnapshotInsert = {
      accountId: report.accountId ?? this.accountId,
      hostId: report.hostId ?? null,
      source: report.source?.trim() || 'statusline',
      fiveHourUsedPercent,
      fiveHourResetsAt: normalizeResetsAt(report.fiveHourResetsAt),
      sevenDayUsedPercent,
      sevenDayResetsAt: normalizeResetsAt(report.sevenDayResetsAt),
      fetchedAt: now,
      createdAt: now,
    };
    const merge = (prior: ClaudeSnapshotRow | undefined) => {
      const key = String(values.accountId ?? 0);
      const short = mergeWindow(
        `${key}:short`,
        { percent: fiveHourUsedPercent, resetsAt: values.fiveHourResetsAt ?? null },
        prior ? { percent: prior.fiveHourUsedPercent, resetsAt: prior.fiveHourResetsAt, fetchedAt: prior.fetchedAt } : null,
        at,
      );
      const weekly = mergeWindow(
        `${key}:weekly`,
        { percent: sevenDayUsedPercent, resetsAt: values.sevenDayResetsAt ?? null },
        prior ? { percent: prior.sevenDayUsedPercent, resetsAt: prior.sevenDayResetsAt, fetchedAt: prior.fetchedAt } : null,
        at,
      );
      values.fiveHourUsedPercent = short.percent;
      values.fiveHourResetsAt = short.resetsAt;
      values.sevenDayUsedPercent = weekly.percent;
      values.sevenDayResetsAt = weekly.resetsAt;
    };
    const owner = ownerRuntimeFor(this.db);
    if (owner) {
      let stored!: ClaudeSnapshotRow;
      await mutateOwnerState(owner, {
        kind: 'usage.claude.report',
        payload: {
          accountId: values.accountId ?? null,
          hostId: values.hostId ?? null,
          fiveHourUsedPercent,
          sevenDayUsedPercent,
          at: now,
        },
        prepare(ctx) {
          const prior = ctx.snapshot
            .table('claudeUsageSnapshots')
            .by('accountId', values.accountId ?? null)
            .slice()
            .sort((a, b) => b.id - a.id)[0];
          merge(prior);
          stageEmulation(ctx, 'claude', values);
          if (
            prior &&
            prior.createdAt.slice(0, 10) === now.slice(0, 10) &&
            sameQuotaObservation(prior, values)
          ) {
            stored = { ...prior, ...values, id: prior.id, createdAt: prior.createdAt } as ClaudeSnapshotRow;
            ctx.draft.upsert('claudeUsageSnapshots', stored);
            return () => stored as unknown as import('../control-plane/commands.js').Json;
          }
          ctx.write(async (tx) => {
            const [inserted] = await tx.insert(claudeUsageSnapshots).values(values);
            stored = {
              ...values,
              id: Number(inserted.insertId),
              accountId: values.accountId ?? null,
              hostId: values.hostId ?? null,
              source: values.source ?? 'statusline',
              fiveHourUsedPercent: values.fiveHourUsedPercent ?? null,
              fiveHourResetsAt: values.fiveHourResetsAt ?? null,
              sevenDayUsedPercent: values.sevenDayUsedPercent ?? null,
              sevenDayResetsAt: values.sevenDayResetsAt ?? null,
            } as ClaudeSnapshotRow;
            // Quota semantics need both latest arrival and latest observed time.
            stageClaudeQuota(ctx.draft, stored);
          });
          return () => stored as unknown as import('../control-plane/commands.js').Json;
        },
      });
      return stored;
    }
    merge(
      (
        await this.db
          .select()
          .from(claudeUsageSnapshots)
          .where(
            values.accountId == null
              ? isNull(claudeUsageSnapshots.accountId)
              : eq(claudeUsageSnapshots.accountId, values.accountId),
          )
          .orderBy(desc(claudeUsageSnapshots.id))
          .limit(1)
      )[0],
    );
    const result = await this.db.insert(claudeUsageSnapshots).values(values);
    const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
    if (typeof insertId === 'number' && insertId > 0) {
      const rows = await this.db
        .select()
        .from(claudeUsageSnapshots)
        .where(eq(claudeUsageSnapshots.id, insertId))
        .limit(1);
      if (rows[0]) { await recordEmulation(this.db, 'claude', rows[0]); return rows[0]; }
    }
    return this.latest();
  }

  async history(params: { days?: number; from?: string | null; until?: string | null }): Promise<{
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
      .where(
        and(
          gte(claudeUsageSnapshots.fetchedAt, fromIso),
          lte(claudeUsageSnapshots.fetchedAt, untilIso),
          this.accountId === undefined
            ? isNull(claudeUsageSnapshots.accountId)
            : eq(claudeUsageSnapshots.accountId, this.accountId),
        ),
      )
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
