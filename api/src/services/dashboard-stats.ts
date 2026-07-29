/**
 * Dashboard rollups for the /admin/overview tile data. Reads the recent/latest
 * `logs` rows and the pre-aggregated quota snapshots in
 * `dashboard_graph_quota_snapshots`.
 */

import { desc, gte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { dashboardGraphQuotaSnapshots, logs } from '../db/schema.js';
import { isoOffsetSeconds } from '../util/timestamp.js';

export class DashboardStatsService {
  constructor(private readonly db: Database) {}

  async recentLogs(limit = 50) {
    const safe = Math.max(1, Math.min(500, limit));
    return this.db.select().from(logs).orderBy(desc(logs.createdAt)).limit(safe);
  }

  async latestLog(): Promise<typeof logs.$inferSelect | null> {
    const rows = await this.db.select().from(logs).orderBy(desc(logs.createdAt)).limit(1);
    return rows[0] ?? null;
  }

  async quotaSnapshots(days = 30): Promise<Array<typeof dashboardGraphQuotaSnapshots.$inferSelect>> {
    const cutoff = isoOffsetSeconds(-days * 86400);
    return this.db
      .select()
      .from(dashboardGraphQuotaSnapshots)
      .where(gte(dashboardGraphQuotaSnapshots.fetchedAt, cutoff))
      .orderBy(dashboardGraphQuotaSnapshots.fetchedAt);
  }
}
