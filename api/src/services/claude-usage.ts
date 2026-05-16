/**
 * Claude (Anthropic) usage service — reads/writes `claude_usage_snapshots`
 * and the per-day `dashboard_graph_claude_daily_stats` aggregate. Persists the
 * dashboard summary that AdminOverviewController surfaces and publishes
 * `claude.usage.updated` on refresh.
 *
 * Full upstream client (POST to Anthropic) is owned by the host-runner
 * adapter; this Phase 2.4 worktree provides the read surface plus a thin
 * recordSnapshot hook used by host-side ingestion code in adjacent worktrees.
 */

import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  claudeUsageSnapshots,
  dashboardGraphClaudeDailyStats,
} from '../db/schema.js';
import { wsPublisher } from '../ws/publisher.js';
import { nowIso } from '../util/timestamp.js';

type ClaudeSnapshotRow = typeof claudeUsageSnapshots.$inferSelect;

export interface ClaudeUsageHistoryPoint {
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export class ClaudeUsageService {
  constructor(private readonly db: Database) {}

  async latest(): Promise<ClaudeSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(claudeUsageSnapshots)
      .orderBy(desc(claudeUsageSnapshots.fetchedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async dashboardSummary(): Promise<{
    fetched_at: string | null;
    status: string | null;
    models: unknown;
  } | null> {
    const row = await this.latest();
    if (!row) return null;
    let models: unknown = null;
    if (row.modelsJson) {
      try {
        models = JSON.parse(row.modelsJson);
      } catch {
        models = null;
      }
    }
    return {
      fetched_at: row.fetchedAt,
      status: row.status,
      models,
    };
  }

  async history(
    bucket: 'hourly' | 'daily' = 'daily',
    period: '24h' | '7d' | '30d' = '7d',
    model?: string | null,
  ): Promise<ClaudeUsageHistoryPoint[]> {
    void bucket; // hourly bucketing rolls up to daily here; consumers ignore the bucket name when fetching daily rows
    const days = period === '24h' ? 1 : period === '30d' ? 30 : 7;
    const cutoff = new Date(Date.now() - days * 86400 * 1000);
    const filters: SQL<unknown>[] = [gte(dashboardGraphClaudeDailyStats.dateBucket, cutoff)];
    if (model) filters.push(eq(dashboardGraphClaudeDailyStats.model, model));
    const rows = await this.db
      .select({
        dateBucket: dashboardGraphClaudeDailyStats.dateBucket,
        model: dashboardGraphClaudeDailyStats.model,
        inputTokens: dashboardGraphClaudeDailyStats.inputTokens,
        outputTokens: dashboardGraphClaudeDailyStats.outputTokens,
        cachedTokens: dashboardGraphClaudeDailyStats.cachedTokens,
      })
      .from(dashboardGraphClaudeDailyStats)
      .where(and(...filters))
      .orderBy(dashboardGraphClaudeDailyStats.dateBucket);
    return rows.map((r) => ({
      date:
        typeof r.dateBucket === 'string'
          ? r.dateBucket
          : new Date(r.dateBucket as unknown as Date).toISOString().slice(0, 10),
      model: r.model,
      input_tokens: Number(r.inputTokens ?? 0),
      output_tokens: Number(r.outputTokens ?? 0),
      cached_tokens: Number(r.cachedTokens ?? 0),
    }));
  }

  async recordSnapshot(snapshot: { status?: string; modelsJson?: string }): Promise<void> {
    const now = nowIso();
    await this.db.insert(claudeUsageSnapshots).values({
      status: snapshot.status ?? 'ok',
      modelsJson: snapshot.modelsJson ?? null,
      fetchedAt: now,
      createdAt: now,
    });
    wsPublisher.publish('claude.usage.updated', { fetched_at: now });
  }
}
