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

import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chatgptUsageSnapshots, dashboardGraphQuotaSnapshots } from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { isoOffsetSeconds, nowIso, parseIso } from '../util/timestamp.js';
import type { Env } from '../env.js';
import type { Keyring } from '../security/keyring.js';
import {
  createRunnerValidationService,
  type RunnerValidationService,
} from './runner-validation.js';
import { ENGINE_CODEX } from '../util/engine.js';

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
type ChatGptSnapshotInsert = typeof chatgptUsageSnapshots.$inferInsert;

const MIN_REFRESH_SECONDS = 300;
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const DEFAULT_TIMEOUT_MS = 10_000;

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

interface ChatGptUsageDeps {
  env?: Pick<Env, 'CHATGPT_BASE_URL' | 'CHATGPT_USAGE_TIMEOUT'>;
  keyring?: Keyring;
  runnerValidation?: RunnerValidationService;
  fetchImpl?: typeof fetch;
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

export function parseChatGptUsageJson(json: Record<string, unknown>): Partial<ChatGptSnapshotInsert> {
  const rate = isRecord(json['rate_limit']) ? json['rate_limit'] : {};
  const primary = isRecord(rate['primary_window']) ? rate['primary_window'] : {};
  const secondary = isRecord(rate['secondary_window']) ? rate['secondary_window'] : {};
  const spark = extractSparkRateLimit(json['additional_rate_limits']);
  const sparkRate = isRecord(spark['rate_limit']) ? spark['rate_limit'] : {};
  const sparkPrimary = isRecord(sparkRate['primary_window']) ? sparkRate['primary_window'] : {};
  const sparkSecondary = isRecord(sparkRate['secondary_window']) ? sparkRate['secondary_window'] : {};
  const credits = isRecord(json['credits']) ? json['credits'] : {};

  return {
    planType: typeof json['plan_type'] === 'string' ? json['plan_type'] : null,
    rateAllowed: boolToTinyint(rate['allowed']),
    rateLimitReached: boolToTinyint(rate['limit_reached']),
    primaryUsedPercent: normalizeInt(primary['used_percent']),
    primaryLimitSeconds: normalizeInt(primary['limit_window_seconds']),
    primaryResetAfterSeconds: normalizeInt(primary['reset_after_seconds']),
    primaryResetAt: typeof primary['reset_at'] === 'string' ? primary['reset_at'] : null,
    secondaryUsedPercent: normalizeInt(secondary['used_percent']),
    secondaryLimitSeconds: normalizeInt(secondary['limit_window_seconds']),
    secondaryResetAfterSeconds: normalizeInt(secondary['reset_after_seconds']),
    secondaryResetAt: typeof secondary['reset_at'] === 'string' ? secondary['reset_at'] : null,
    sparkLimitName: typeof spark['limit_name'] === 'string' ? spark['limit_name'].trim() : null,
    sparkMeteredFeature: typeof spark['metered_feature'] === 'string' ? spark['metered_feature'].trim() : null,
    sparkRateAllowed: boolToTinyint(sparkRate['allowed']),
    sparkRateLimitReached: boolToTinyint(sparkRate['limit_reached']),
    sparkPrimaryUsedPercent: normalizeInt(sparkPrimary['used_percent']),
    sparkPrimaryLimitSeconds: normalizeInt(sparkPrimary['limit_window_seconds']),
    sparkPrimaryResetAfterSeconds: normalizeInt(sparkPrimary['reset_after_seconds']),
    sparkPrimaryResetAt: typeof sparkPrimary['reset_at'] === 'string' ? sparkPrimary['reset_at'] : null,
    sparkSecondaryUsedPercent: normalizeInt(sparkSecondary['used_percent']),
    sparkSecondaryLimitSeconds: normalizeInt(sparkSecondary['limit_window_seconds']),
    sparkSecondaryResetAfterSeconds: normalizeInt(sparkSecondary['reset_after_seconds']),
    sparkSecondaryResetAt: typeof sparkSecondary['reset_at'] === 'string' ? sparkSecondary['reset_at'] : null,
    hasCredits: boolToTinyint(credits['has_credits']),
    unlimited: boolToTinyint(credits['unlimited']),
    creditBalance: credits['balance'] === undefined || credits['balance'] === null ? null : String(credits['balance']),
    approxLocalMessages: encodeJsonField(credits['approx_local_messages']),
    approxCloudMessages: encodeJsonField(credits['approx_cloud_messages']),
  };
}

export class ChatGptUsageService {
  private readonly validation: RunnerValidationService;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Database,
    private readonly log?: Logger,
    private readonly deps: ChatGptUsageDeps = {},
  ) {
    this.validation = deps.runnerValidation ?? createRunnerValidationService({ db, keyring: deps.keyring });
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = deps.env?.CHATGPT_BASE_URL ?? DEFAULT_BASE_URL;
    this.timeoutMs = Math.max(1000, Math.round((deps.env?.CHATGPT_USAGE_TIMEOUT ?? 10) * 1000)) || DEFAULT_TIMEOUT_MS;
  }

  async latest(): Promise<ChatGptSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(chatgptUsageSnapshots)
      .orderBy(desc(chatgptUsageSnapshots.fetchedAt), desc(chatgptUsageSnapshots.id))
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

    const refreshed = await this.fetchAndStore();
    if (refreshed.status === 'ok' || refreshed.snapshot) return refreshed;

    if (latest && !force) {
      return {
        status: 'ok',
        snapshot: this.normalizeSnapshot(latest),
        cached: true,
        next_eligible_at: latest.nextEligibleAt,
        error: refreshed.error ?? null,
      };
    }
    return refreshed;
  }

  async refresh(): Promise<FetchResult> {
    const result = await this.fetchLatest(true);
    wsPublisher.publish('chatgpt.usage.updated', {
      fetched_at: (result.snapshot?.['fetched_at'] as string | undefined) ?? nowIso(),
    });
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

  private async fetchAndStore(): Promise<FetchResult> {
    const now = nowIso();
    const nextEligible = isoOffsetSeconds(MIN_REFRESH_SECONDS);
    const canonical = await this.validation.resolveCanonicalPayload(ENGINE_CODEX);
    const validated = this.validation.validateCanonicalPayload(canonical);
    if (!validated) {
      return this.storeError('missing_canonical_auth', 'Canonical Codex auth.json not available');
    }

    const tokens = isRecord(validated.auth['tokens']) ? validated.auth['tokens'] : null;
    const accessToken = typeof tokens?.['access_token'] === 'string' ? tokens['access_token'].trim() : '';
    if (!accessToken) {
      return this.storeError('missing_token', 'access_token missing or empty in canonical auth.json');
    }
    const accountId = typeof tokens?.['account_id'] === 'string' && tokens['account_id'].trim()
      ? tokens['account_id'].trim()
      : null;

    const response = await this.requestUsage(accessToken, accountId);
    if (response.error) {
      return this.storeError(response.error, response.error, response.body, response.status);
    }

    const parsed = parseChatGptUsageJson(response.json as Record<string, unknown>);
    const row = await this.insertSnapshot({
      ...parsed,
      status: 'ok',
      raw: response.body,
      error: null,
      fetchedAt: now,
      nextEligibleAt: nextEligible,
      createdAt: now,
    });
    await this.recordGraphSnapshot(row);
    this.log?.info?.({ status: 'ok', fetched_at: row.fetchedAt }, 'chatgpt.usage refreshed');
    return {
      status: 'ok',
      snapshot: this.normalizeSnapshot(row),
      cached: false,
      next_eligible_at: row.nextEligibleAt,
    };
  }

  private async requestUsage(
    accessToken: string,
    accountId: string | null,
  ): Promise<{ status: number; body: string; json: Record<string, unknown>; error: null } | { status: number; body: string; json: Record<string, unknown> | null; error: string }> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/wham/usage`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex-auth',
      };
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      const res = await this.fetchImpl(url, { headers, signal: controller.signal });
      const body = await res.text();
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch (err) {
        return {
          status: res.status,
          body,
          json: null,
          error: err instanceof Error ? err.message : 'Invalid JSON payload',
        };
      }
      if (!res.ok) {
        return {
          status: res.status,
          body,
          json: isRecord(json) ? json : null,
          error: `HTTP ${res.status}`,
        };
      }
      if (!isRecord(json)) {
        return { status: res.status, body, json: null, error: 'Invalid JSON payload' };
      }
      return { status: res.status, body, json, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'fetch failed';
      return { status: 0, body: '', json: null, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async storeError(
    reason: string,
    message: string,
    raw: string | null = null,
    httpStatus: number | null = null,
  ): Promise<FetchResult> {
    const now = nowIso();
    const row = await this.insertSnapshot({
      status: 'error',
      error: message,
      raw,
      fetchedAt: now,
      nextEligibleAt: isoOffsetSeconds(MIN_REFRESH_SECONDS),
      createdAt: now,
    });
    await this.recordGraphSnapshot(row);
    this.log?.warn?.({ reason, http_status: httpStatus, fetched_at: row.fetchedAt }, 'chatgpt.usage refresh failed');
    return {
      status: 'error',
      snapshot: this.normalizeSnapshot(row),
      cached: false,
      next_eligible_at: row.nextEligibleAt,
      error: message,
    };
  }

  private async insertSnapshot(values: ChatGptSnapshotInsert): Promise<ChatGptSnapshotRow> {
    const result = await this.db.insert(chatgptUsageSnapshots).values(values);
    // mysql2 returns [{ insertId, affectedRows }, fields]; select the row we just
    // inserted by id instead of "latest by fetchedAt" so concurrent refreshes
    // (e.g. a manual refresh racing a scheduled one) can't hand this call back
    // a different request's row.
    const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
    if (typeof insertId === 'number' && insertId > 0) {
      const rows = await this.db
        .select()
        .from(chatgptUsageSnapshots)
        .where(eq(chatgptUsageSnapshots.id, insertId))
        .limit(1);
      if (rows[0]) return rows[0];
    }
    const row = await this.latest();
    if (!row) throw new Error('Failed to persist ChatGPT usage snapshot');
    return row;
  }

  private async recordGraphSnapshot(row: ChatGptSnapshotRow): Promise<void> {
    try {
      await this.db.insert(dashboardGraphQuotaSnapshots).values({
        fetchedAt: row.fetchedAt,
        primaryUsedPercent: row.primaryUsedPercent,
        primaryLimitSeconds: row.primaryLimitSeconds,
        secondaryUsedPercent: row.secondaryUsedPercent,
        secondaryLimitSeconds: row.secondaryLimitSeconds,
        sparkPrimaryUsedPercent: row.sparkPrimaryUsedPercent,
        sparkPrimaryLimitSeconds: row.sparkPrimaryLimitSeconds,
        sparkSecondaryUsedPercent: row.sparkSecondaryUsedPercent,
        sparkSecondaryLimitSeconds: row.sparkSecondaryLimitSeconds,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    } catch {
      // The snapshot itself is authoritative; graph persistence must not break refresh.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boolToTinyint(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

function normalizeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function encodeJsonField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function extractSparkRateLimit(limits: unknown): Record<string, unknown> {
  if (!Array.isArray(limits)) return {};
  let winner: Record<string, unknown> = {};
  let winnerScore = 0;
  for (const candidate of limits) {
    if (!isRecord(candidate)) continue;
    const rate = candidate['rate_limit'];
    if (!isRecord(rate)) continue;
    const limitName = typeof candidate['limit_name'] === 'string' ? candidate['limit_name'].toLowerCase().trim() : '';
    const meteredFeature =
      typeof candidate['metered_feature'] === 'string' ? candidate['metered_feature'].toLowerCase().trim() : '';
    let score = 0;
    if (limitName.includes('spark')) score = 3;
    else if (meteredFeature.includes('spark')) score = 2;
    else if (meteredFeature.includes('bengalfox')) score = 1;
    if (score > winnerScore) {
      winner = candidate;
      winnerScore = score;
    }
  }
  return winnerScore > 0 ? winner : {};
}
