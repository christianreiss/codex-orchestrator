/**
 * Admin-side memories CRUD over `mcp_memories`. Hosts write via the MCP
 * tools; the admin view here is the cross-host firehose with search +
 * delete. Soft-delete is via `deleted_at`; the admin "delete" path actually
 * deletes the row to free up the (host_id, memory_key) unique slot.
 */
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { mcpMemories } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../http/errors.js';
import { wsPublisher } from '../ws/publisher.js';

export interface MemoryView {
  id: number;
  host_id: number;
  memory_key: string;
  content: string;
  metadata: unknown;
  tags: string[];
  summary: string | null;
  engine: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MemorySearchInput {
  query?: unknown;
  q?: unknown;
  limit?: unknown;
  host_id?: unknown;
  tags?: unknown;
}

export interface MemorySearchResult {
  status: 'ok';
  query: string;
  host_id: number | null;
  limit: number;
  count: number;
  matches: MemoryView[];
}

function toView(row: typeof mcpMemories.$inferSelect): MemoryView {
  let tags: string[] = [];
  if (Array.isArray(row.tags)) {
    tags = row.tags.filter((t): t is string => typeof t === 'string');
  }
  return {
    id: row.id,
    host_id: row.hostId,
    memory_key: row.memoryKey,
    content: row.content,
    metadata: row.metadata ?? null,
    tags,
    summary: row.summary,
    engine: row.engine,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  };
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  return [];
}

export class MemoriesService {
  constructor(private readonly db: Database) {}

  async adminSearch(input: MemorySearchInput): Promise<MemorySearchResult> {
    const queryRaw = typeof input.query === 'string' ? input.query : typeof input.q === 'string' ? input.q : '';
    const query = queryRaw.trim();
    let limit = typeof input.limit === 'number' ? input.limit : Number(input.limit ?? 50);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(200, Math.trunc(limit)));

    let hostId: number | null = null;
    if (input.host_id !== undefined && input.host_id !== null && input.host_id !== '') {
      const n = Number(input.host_id);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        throw new ValidationError('host_id must be a positive integer', { param: 'host_id' });
      }
      hostId = n;
    }

    const searchTags = normalizeTags(input.tags).map((t) => t.toLowerCase());

    const conditions = [isNull(mcpMemories.deletedAt)];
    if (hostId !== null) conditions.push(eq(mcpMemories.hostId, hostId));
    if (query !== '') {
      const pattern = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
      const orExpr = or(
        like(mcpMemories.memoryKey, pattern),
        like(mcpMemories.content, pattern),
        like(mcpMemories.tagsText, pattern),
      );
      if (orExpr) conditions.push(orExpr);
    }

    // Tag filtering happens in JS below (tags is a JSON column, not indexed
    // for containment queries), so page through the query results in batches
    // until we have `limit` matches or the underlying result set is
    // exhausted. A single fixed-size fetch would silently drop matches that
    // fall outside the first page whenever a tag filter is applied.
    const batchSize = limit * (searchTags.length > 0 ? 3 : 1);
    const filtered: MemoryView[] = [];
    let offset = 0;
    for (;;) {
      const rows = await this.db
        .select()
        .from(mcpMemories)
        .where(and(...conditions))
        .orderBy(desc(mcpMemories.updatedAt), desc(mcpMemories.id))
        .limit(batchSize)
        .offset(offset);

      for (const r of rows) {
        const view = toView(r);
        if (searchTags.length > 0) {
          const rowTags = view.tags.map((t) => t.toLowerCase());
          if (!searchTags.every((t) => rowTags.includes(t))) continue;
        }
        filtered.push(view);
        if (filtered.length >= limit) break;
      }
      if (filtered.length >= limit || rows.length < batchSize) break;
      offset += batchSize;
    }

    return {
      status: 'ok',
      query,
      host_id: hostId,
      limit,
      count: filtered.length,
      matches: filtered,
    };
  }

  async adminDelete(id: number): Promise<{ deleted: number }> {
    if (!Number.isInteger(id) || id < 1) {
      throw new ValidationError('id must be a positive integer', { param: 'id' });
    }
    const rows = await this.db
      .select({ id: mcpMemories.id, hostId: mcpMemories.hostId, memoryKey: mcpMemories.memoryKey })
      .from(mcpMemories)
      .where(eq(mcpMemories.id, id))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundError('Memory not found', 'memory_not_found');
    }
    await this.db.delete(mcpMemories).where(eq(mcpMemories.id, id));
    wsPublisher.publish('memory.deleted', { id, host_id: rows[0].hostId, memory_key: rows[0].memoryKey });
    wsPublisher.publish('memory.changed', { id, host_id: rows[0].hostId });
    return { deleted: id };
  }

  /**
   * Test seam: bulk count for assertions.
   */
  async _count(): Promise<number> {
    const rows = await this.db.select({ c: sql<number>`count(*)` }).from(mcpMemories);
    return Number(rows[0]?.c ?? 0);
  }
}
