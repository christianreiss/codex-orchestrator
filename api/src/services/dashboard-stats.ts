/**
 * Dashboard rollups for the /admin/overview tile data. Computes today / week
 * / month token totals from `token_usages` and the per-host top-N. Also reads
 * the pre-aggregated rows in `dashboard_graph_usage_daily_stats` and
 * `dashboard_graph_quota_snapshots`.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  tokenUsages,
  tokenUsageIngests,
  dashboardGraphUsageDailyStats,
  dashboardGraphQuotaSnapshots,
  hosts,
  logs,
} from '../db/schema.js';

export interface TokenTotals {
  total: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  entries: number;
}

type SumRow = {
  total: string | number | null;
  input: string | number | null;
  output: string | number | null;
  cached: string | number | null;
  reasoning: string | number | null;
  entries: string | number | null;
};

export class DashboardStatsService {
  constructor(private readonly db: Database) {}

  async totals(): Promise<TokenTotals> {
    const rows = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${tokenUsages.total}), 0)`,
        input: sql<string>`COALESCE(SUM(${tokenUsages.inputTokens}), 0)`,
        output: sql<string>`COALESCE(SUM(${tokenUsages.outputTokens}), 0)`,
        cached: sql<string>`COALESCE(SUM(${tokenUsages.cachedTokens}), 0)`,
        reasoning: sql<string>`COALESCE(SUM(${tokenUsages.reasoningTokens}), 0)`,
        entries: sql<string>`COUNT(*)`,
      })
      .from(tokenUsages);
    return this.mapTotals(rows[0]);
  }

  async totalsForRange(fromIso: string, untilIso: string): Promise<TokenTotals> {
    const rows = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${tokenUsages.total}), 0)`,
        input: sql<string>`COALESCE(SUM(${tokenUsages.inputTokens}), 0)`,
        output: sql<string>`COALESCE(SUM(${tokenUsages.outputTokens}), 0)`,
        cached: sql<string>`COALESCE(SUM(${tokenUsages.cachedTokens}), 0)`,
        reasoning: sql<string>`COALESCE(SUM(${tokenUsages.reasoningTokens}), 0)`,
        entries: sql<string>`COUNT(*)`,
      })
      .from(tokenUsages)
      .where(and(gte(tokenUsages.createdAt, fromIso), lt(tokenUsages.createdAt, untilIso)));
    return this.mapTotals(rows[0]);
  }

  async topHost(): Promise<{ host_id: number; fqdn: string | null; total: number } | null> {
    const rows = await this.db
      .select({
        hostId: tokenUsages.hostId,
        total: sql<string>`COALESCE(SUM(${tokenUsages.total}), 0)`,
      })
      .from(tokenUsages)
      .groupBy(tokenUsages.hostId)
      .orderBy(desc(sql`COALESCE(SUM(${tokenUsages.total}), 0)`))
      .limit(1);
    const row = rows[0];
    if (!row || row.hostId === null) return null;
    const hostId = Number(row.hostId);
    const hostRow = await this.db
      .select({ fqdn: hosts.fqdn })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);
    return { host_id: hostId, fqdn: hostRow[0]?.fqdn ?? null, total: Number(row.total) };
  }

  async recentTokens(limit = 50) {
    const safe = Math.max(1, Math.min(500, limit));
    return this.db.select().from(tokenUsages).orderBy(desc(tokenUsages.createdAt)).limit(safe);
  }

  async topTokens(limit = 50) {
    const safe = Math.max(1, Math.min(500, limit));
    const rows = await this.db
      .select({
        hostId: tokenUsages.hostId,
        total: sql<string>`COALESCE(SUM(${tokenUsages.total}), 0)`,
        input: sql<string>`COALESCE(SUM(${tokenUsages.inputTokens}), 0)`,
        output: sql<string>`COALESCE(SUM(${tokenUsages.outputTokens}), 0)`,
        entries: sql<string>`COUNT(*)`,
      })
      .from(tokenUsages)
      .groupBy(tokenUsages.hostId)
      .orderBy(desc(sql`COALESCE(SUM(${tokenUsages.total}), 0)`))
      .limit(safe);
    return rows.map((r) => ({
      host_id: r.hostId === null ? null : Number(r.hostId),
      total: Number(r.total),
      input_tokens: Number(r.input),
      output_tokens: Number(r.output),
      entries: Number(r.entries),
    }));
  }

  async ingestsSearch(params: {
    page?: number;
    perPage?: number;
    hostId?: number | null;
    query?: string | null;
    sort?: string;
    direction?: 'asc' | 'desc';
  }) {
    const page = Math.max(1, params.page ?? 1);
    const perPage = Math.max(1, Math.min(200, params.perPage ?? 50));
    const offset = (page - 1) * perPage;

    const filters = [];
    if (params.hostId !== null && params.hostId !== undefined && Number.isFinite(params.hostId)) {
      filters.push(eq(tokenUsageIngests.hostId, params.hostId));
    }

    const baseRows = filters.length > 0
      ? this.db.select().from(tokenUsageIngests).where(and(...filters))
      : this.db.select().from(tokenUsageIngests);
    const rows = await baseRows.orderBy(desc(tokenUsageIngests.createdAt)).limit(perPage).offset(offset);

    const totalQuery = filters.length > 0
      ? this.db.select({ c: sql<string>`COUNT(*)` }).from(tokenUsageIngests).where(and(...filters))
      : this.db.select({ c: sql<string>`COUNT(*)` }).from(tokenUsageIngests);
    const totalRows = await totalQuery;
    const total = Number(totalRows[0]?.c ?? 0);

    return {
      page,
      per_page: perPage,
      total,
      items: rows,
    };
  }

  async recentLogs(limit = 50) {
    const safe = Math.max(1, Math.min(500, limit));
    return this.db.select().from(logs).orderBy(desc(logs.createdAt)).limit(safe);
  }

  async latestLog(): Promise<typeof logs.$inferSelect | null> {
    const rows = await this.db.select().from(logs).orderBy(desc(logs.createdAt)).limit(1);
    return rows[0] ?? null;
  }

  async dailyStats(days = 30): Promise<Array<typeof dashboardGraphUsageDailyStats.$inferSelect>> {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    return this.db
      .select()
      .from(dashboardGraphUsageDailyStats)
      .where(gte(dashboardGraphUsageDailyStats.statDate, cutoff))
      .orderBy(dashboardGraphUsageDailyStats.statDate);
  }

  async quotaSnapshots(days = 30): Promise<Array<typeof dashboardGraphQuotaSnapshots.$inferSelect>> {
    const cutoff = new Date(Date.now() - days * 86400 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    return this.db
      .select()
      .from(dashboardGraphQuotaSnapshots)
      .where(gte(dashboardGraphQuotaSnapshots.fetchedAt, cutoff))
      .orderBy(dashboardGraphQuotaSnapshots.fetchedAt);
  }

  private mapTotals(row: SumRow | undefined): TokenTotals {
    if (!row) {
      return {
        total: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        entries: 0,
      };
    }
    return {
      total: Number(row.total ?? 0),
      input_tokens: Number(row.input ?? 0),
      output_tokens: Number(row.output ?? 0),
      cached_tokens: Number(row.cached ?? 0),
      reasoning_tokens: Number(row.reasoning ?? 0),
      entries: Number(row.entries ?? 0),
    };
  }
}
