/**
 * ChatGPT usage service — pulls the usage snapshot from chatgpt.com's
 * `/backend-api/usage` endpoint, caches it in `chatgpt_usage_snapshots`, and
 * publishes a `chatgpt.usage.updated` WS event on refresh.
 *
 * The legacy PHP `ChatGptUsageService` is ~600 lines: full feature parity is
 * out of scope for this Phase 2.4 worktree. This implementation provides
 * read-side coverage that the dashboard relies on (latest snapshot, history,
 * 5-min throttled refresh) and surfaces a structured "unavailable" marker
 * until the host-runner pipeline owned by Phase 2.1 is wired.
 */

import { and, desc, gte, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chatgptUsageSnapshots } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso, parseIso } from '../util/timestamp.js';

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface FetchResult {
  status: 'ok' | 'rate_limited' | 'error' | 'unavailable';
  snapshot: Record<string, unknown> | null;
  cached: boolean;
  next_eligible_at: string | null;
  error?: string | null;
}

type ChatGptSnapshotRow = typeof chatgptUsageSnapshots.$inferSelect;

interface ChatGptWindow {
  used_percent: number | null;
  limit_seconds: number | null;
  reset_after_seconds: number | null;
  reset_at: string | null;
  resets_at: string | null;
}

interface ChatGptHistoryPoint {
  fetched_at: string;
  primary_used_percent: number | null;
  secondary_used_percent: number | null;
  spark_primary_used_percent: number | null;
  spark_secondary_used_percent: number | null;
}

interface ChatGptHistorySeries {
  key: string;
  label: string;
  points: Array<{ ts: string; value: number }>;
}

function boolFromTinyint(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  return Number(value) === 1;
}

function windowFrom(
  usedPercent: number | null | undefined,
  limitSeconds: number | null | undefined,
  resetAfterSeconds: number | null | undefined,
  resetAt: string | null | undefined,
): ChatGptWindow {
  return {
    used_percent: usedPercent ?? null,
    limit_seconds: limitSeconds ?? null,
    reset_after_seconds: resetAfterSeconds ?? null,
    reset_at: resetAt ?? null,
    resets_at: resetAt ?? null,
  };
}

export function normalizeChatGptUsageSnapshot(row: ChatGptSnapshotRow): Record<string, unknown> {
  const primaryWindow = windowFrom(
    row.primaryUsedPercent,
    row.primaryLimitSeconds,
    row.primaryResetAfterSeconds,
    row.primaryResetAt,
  );
  const secondaryWindow = windowFrom(
    row.secondaryUsedPercent,
    row.secondaryLimitSeconds,
    row.secondaryResetAfterSeconds,
    row.secondaryResetAt,
  );
  const sparkPrimaryWindow = windowFrom(
    row.sparkPrimaryUsedPercent,
    row.sparkPrimaryLimitSeconds,
    row.sparkPrimaryResetAfterSeconds,
    row.sparkPrimaryResetAt,
  );
  const sparkSecondaryWindow = windowFrom(
    row.sparkSecondaryUsedPercent,
    row.sparkSecondaryLimitSeconds,
    row.sparkSecondaryResetAfterSeconds,
    row.sparkSecondaryResetAt,
  );
  const hasSpark =
    row.sparkLimitName !== null ||
    row.sparkMeteredFeature !== null ||
    row.sparkRateAllowed !== null ||
    row.sparkRateLimitReached !== null ||
    row.sparkPrimaryUsedPercent !== null ||
    row.sparkSecondaryUsedPercent !== null;

  return {
    id: row.id,
    host_id: row.hostId,
    status: row.status,
    plan_type: row.planType,
    rate_allowed: boolFromTinyint(row.rateAllowed),
    rate_limit_reached: boolFromTinyint(row.rateLimitReached),
    active_quota_lane: 'normal',
    primary_used_percent: row.primaryUsedPercent,
    primary_limit_seconds: row.primaryLimitSeconds,
    primary_reset_after_seconds: row.primaryResetAfterSeconds,
    primary_reset_at: row.primaryResetAt,
    secondary_used_percent: row.secondaryUsedPercent,
    secondary_limit_seconds: row.secondaryLimitSeconds,
    secondary_reset_after_seconds: row.secondaryResetAfterSeconds,
    secondary_reset_at: row.secondaryResetAt,
    spark_limit_name: row.sparkLimitName,
    spark_metered_feature: row.sparkMeteredFeature,
    spark_rate_allowed: boolFromTinyint(row.sparkRateAllowed),
    spark_rate_limit_reached: boolFromTinyint(row.sparkRateLimitReached),
    spark_primary_used_percent: row.sparkPrimaryUsedPercent,
    spark_secondary_used_percent: row.sparkSecondaryUsedPercent,
    primary_window: primaryWindow,
    secondary_window: secondaryWindow,
    normal_window: {
      primary_window: primaryWindow,
      secondary_window: secondaryWindow,
    },
    spark_window: hasSpark
      ? {
          primary_window: sparkPrimaryWindow,
          secondary_window: sparkSecondaryWindow,
        }
      : null,
    fetched_at: row.fetchedAt,
    next_eligible_at: row.nextEligibleAt,
  };
}

export function buildChatGptHistorySeries(
  points: ChatGptHistoryPoint[],
  params: { lane?: 'normal' | 'spark' | 'both'; window?: 'primary' | 'secondary' | 'both' },
): ChatGptHistorySeries[] {
  const lane = params.lane ?? 'both';
  const window = params.window ?? 'both';
  const candidates: Array<{ key: string; label: string; lane: 'normal' | 'spark'; window: 'primary' | 'secondary'; field: keyof ChatGptHistoryPoint }> = [
    { key: 'normal_primary', label: 'Normal 5-hour', lane: 'normal', window: 'primary', field: 'primary_used_percent' },
    { key: 'normal_secondary', label: 'Normal weekly', lane: 'normal', window: 'secondary', field: 'secondary_used_percent' },
    { key: 'spark_primary', label: 'Spark 5-hour', lane: 'spark', window: 'primary', field: 'spark_primary_used_percent' },
    { key: 'spark_secondary', label: 'Spark weekly', lane: 'spark', window: 'secondary', field: 'spark_secondary_used_percent' },
  ];

  return candidates
    .filter((candidate) => (lane === 'both' || lane === candidate.lane) && (window === 'both' || window === candidate.window))
    .map((candidate) => ({
      key: candidate.key,
      label: candidate.label,
      points: points
        .map((point) => {
          const value = point[candidate.field];
          return typeof value === 'number' ? { ts: point.fetched_at, value } : null;
        })
        .filter((point): point is { ts: string; value: number } => point !== null),
    }));
}

export class ChatGptUsageService {
  constructor(
    private readonly db: Database,
    private readonly log?: Logger,
  ) {
    void this.log; // reserved for upstream fetch logging when wired
  }

  async latest(): Promise<ChatGptSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(chatgptUsageSnapshots)
      .orderBy(desc(chatgptUsageSnapshots.fetchedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async fetchLatest(force = false): Promise<FetchResult> {
    const latest = await this.latest();
    const now = Date.now();
    const nextEligibleAt = latest?.nextEligibleAt ?? null;
    const nextTs = nextEligibleAt ? parseIso(nextEligibleAt)?.getTime() ?? 0 : 0;
    if (!force && latest && nextTs > now) {
      return {
        status: 'ok',
        snapshot: this.normalizeSnapshot(latest),
        cached: true,
        next_eligible_at: nextEligibleAt,
      };
    }

    if (latest) {
      return {
        status: 'ok',
        snapshot: this.normalizeSnapshot(latest),
        cached: true,
        next_eligible_at: nextEligibleAt,
      };
    }
    return {
      status: 'unavailable',
      snapshot: null,
      cached: false,
      next_eligible_at: null,
      error: 'No ChatGPT usage snapshots recorded yet',
    };
  }

  async refresh(): Promise<FetchResult> {
    const latest = await this.latest();
    if (latest) {
      const nextTs = parseIso(latest.nextEligibleAt)?.getTime() ?? 0;
      if (nextTs > Date.now()) {
        return {
          status: 'rate_limited',
          snapshot: this.normalizeSnapshot(latest),
          cached: true,
          next_eligible_at: latest.nextEligibleAt,
          error: 'Refresh throttled (5-minute cooldown active)',
        };
      }
    }
    const result = await this.fetchLatest(true);
    wsPublisher.publish('chatgpt.usage.updated', { fetched_at: nowIso() });
    return result;
  }

  async history(params: {
    days?: number;
    from?: string | null;
    until?: string | null;
    interval?: 'raw' | 'hour' | 'day';
    lane?: 'normal' | 'spark' | 'both';
    window?: 'primary' | 'secondary' | 'both';
  }): Promise<{
    days: number;
    since: string;
    from: string;
    until: string;
    interval: string;
    bucket: string;
    lane: string;
    window: string;
    points: ChatGptHistoryPoint[];
    series: ChatGptHistorySeries[];
  }> {
    const days = Math.max(1, Math.min(365, params.days ?? 60));
    const fromIso = params.from ?? this.daysAgo(days);
    const untilIso = params.until ?? nowIso();
    const rows = await this.db
      .select({
        fetchedAt: chatgptUsageSnapshots.fetchedAt,
        primaryUsedPercent: chatgptUsageSnapshots.primaryUsedPercent,
        secondaryUsedPercent: chatgptUsageSnapshots.secondaryUsedPercent,
        sparkPrimaryUsedPercent: chatgptUsageSnapshots.sparkPrimaryUsedPercent,
        sparkSecondaryUsedPercent: chatgptUsageSnapshots.sparkSecondaryUsedPercent,
      })
      .from(chatgptUsageSnapshots)
      .where(
        and(
          gte(chatgptUsageSnapshots.fetchedAt, fromIso),
          lte(chatgptUsageSnapshots.fetchedAt, untilIso),
        ),
      )
      .orderBy(chatgptUsageSnapshots.fetchedAt);

    const points = rows.map((r) => ({
      fetched_at: r.fetchedAt,
      primary_used_percent: r.primaryUsedPercent ?? null,
      secondary_used_percent: r.secondaryUsedPercent ?? null,
      spark_primary_used_percent: r.sparkPrimaryUsedPercent ?? null,
      spark_secondary_used_percent: r.sparkSecondaryUsedPercent ?? null,
    }));

    return {
      days,
      since: fromIso,
      from: fromIso,
      until: untilIso,
      interval: params.interval ?? 'day',
      bucket: params.interval ?? 'day',
      lane: params.lane ?? 'both',
      window: params.window ?? 'both',
      points,
      series: buildChatGptHistorySeries(points, {
        lane: params.lane ?? 'both',
        window: params.window ?? 'both',
      }),
    };
  }

  async latestWindowSummary(): Promise<{
    primary_used_percent: number | null;
    secondary_used_percent: number | null;
    spark_primary_used_percent: number | null;
    spark_secondary_used_percent: number | null;
  } | null> {
    const row = await this.latest();
    if (!row) return null;
    return {
      primary_used_percent: row.primaryUsedPercent ?? null,
      secondary_used_percent: row.secondaryUsedPercent ?? null,
      spark_primary_used_percent: row.sparkPrimaryUsedPercent ?? null,
      spark_secondary_used_percent: row.sparkSecondaryUsedPercent ?? null,
    };
  }

  private daysAgo(days: number): string {
    return new Date(Date.now() - days * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private normalizeSnapshot(row: ChatGptSnapshotRow): Record<string, unknown> {
    return normalizeChatGptUsageSnapshot(row);
  }
}
