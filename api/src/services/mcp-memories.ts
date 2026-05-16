/**
 * MCP host-scoped memories. Ports src/Services/MemoryService.php with the
 * same validation rules and response shapes.
 */
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { mcpMemories, logs } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';

const MAX_CONTENT = 32000;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const KEY_RE = /^[A-Za-z0-9._:-]+$/;
const RESERVED_COCO = /^coco(?:$|[._:-])/i;

export class McpMemoriesService {
  constructor(private readonly db: Database) {}

  async store(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    let memoryKey = this.normalizeKey(payload['id'] ?? payload['memory_id'] ?? payload['key'], true, errors);

    const contentRaw = payload['content'] ?? payload['text'] ?? '';
    const content = String(contentRaw ?? '').trim();
    if (!content) errors['content'] = (errors['content'] ?? []).concat('content is required');
    if (content.length > MAX_CONTENT) errors['content'] = (errors['content'] ?? []).concat(`content must be ${MAX_CONTENT} characters or fewer`);

    const metadata = this.normalizeMetadata(payload['metadata'], errors);
    const tags = this.normalizeTags(payload['tags'], errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    memoryKey = memoryKey ?? this.generateKey();
    const hostId = host.id;

    const existingRows = await this.db
      .select()
      .from(mcpMemories)
      .where(and(eq(mcpMemories.hostId, hostId), eq(mcpMemories.memoryKey, memoryKey), isNull(mcpMemories.deletedAt)))
      .limit(1);
    const existing = existingRows[0];

    let status: 'created' | 'updated' | 'unchanged' = 'created';
    if (existing) {
      const sameContent = (existing.content ?? '') === content;
      const existingTagsNorm = this.normalizedArray(parseTags(existing.tags));
      const newTagsNorm = this.normalizedArray(tags);
      const existingMetaNorm = this.normalizedAssoc((existing.metadata as Record<string, unknown> | null) ?? null);
      const newMetaNorm = this.normalizedAssoc(metadata);
      const sameTags = JSON.stringify(existingTagsNorm) === JSON.stringify(newTagsNorm);
      const sameMeta = JSON.stringify(existingMetaNorm) === JSON.stringify(newMetaNorm);
      status = sameContent && sameTags && sameMeta ? 'unchanged' : 'updated';
    }

    const now = nowIso();
    const tagsText = tags.length > 0 ? tags.join(' ') : null;
    await this.db
      .insert(mcpMemories)
      .values({
        hostId,
        memoryKey,
        content,
        metadata: metadata ?? null,
        tags: tags.length > 0 ? tags : null,
        tagsText,
        summary: existing?.summary ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .onDuplicateKeyUpdate({
        set: {
          content,
          metadata: metadata ?? null,
          tags: tags.length > 0 ? tags : null,
          tagsText,
          updatedAt: now,
          deletedAt: null,
        },
      });

    const savedRows = await this.db
      .select()
      .from(mcpMemories)
      .where(and(eq(mcpMemories.hostId, hostId), eq(mcpMemories.memoryKey, memoryKey)))
      .limit(1);
    const saved = savedRows[0] ?? null;

    await this.recordLog(hostId, 'memory.store', { id: memoryKey, status, content_length: content.length, tags: tags.length });
    wsPublisher.publish(status === 'created' ? 'memory.created' : 'memory.changed', { id: memoryKey, host_id: hostId });

    return {
      status,
      id: memoryKey,
      memory: saved ? this.formatMemory(saved) : null,
    };
  }

  async retrieve(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const memoryKey = this.normalizeKey(payload['id'] ?? payload['memory_id'] ?? payload['key'], false, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });
    if (!memoryKey) throw new ValidationError('Validation failed', { extra: { errors: { id: ['id is required'] } } });

    const rows = await this.db
      .select()
      .from(mcpMemories)
      .where(and(eq(mcpMemories.hostId, host.id), eq(mcpMemories.memoryKey, memoryKey), isNull(mcpMemories.deletedAt)))
      .limit(1);

    const status = rows[0] ? 'found' : 'missing';
    await this.recordLog(host.id, 'memory.retrieve', { id: memoryKey, status });
    return {
      status,
      id: memoryKey,
      memory: rows[0] ? this.formatMemory(rows[0]) : null,
    };
  }

  async search(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const queryRaw = payload['query'] ?? payload['q'] ?? '';
    const query = String(queryRaw ?? '').trim();
    let limit =
      typeof payload['limit'] === 'number'
        ? Math.trunc(payload['limit'] as number)
        : typeof payload['limit'] === 'string' && /^\d+$/.test(payload['limit'] as string)
          ? Number.parseInt(payload['limit'] as string, 10)
          : 20;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    const tags = this.normalizeTags(payload['tags'], errors);
    const searchTags = this.normalizedArray(tags);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const fetchLimit = limit * (searchTags.length > 0 ? 3 : 1);

    let rawResults: Array<Record<string, unknown>>;
    if (!query) {
      const rows = await this.db
        .select()
        .from(mcpMemories)
        .where(and(eq(mcpMemories.hostId, host.id), isNull(mcpMemories.deletedAt)))
        .orderBy(desc(mcpMemories.updatedAt), desc(mcpMemories.id))
        .limit(fetchLimit);
      rawResults = rows as unknown as Array<Record<string, unknown>>;
    } else {
      const res = await this.db.execute(
        sql`SELECT id, host_id, memory_key, content, metadata, tags, summary, created_at, updated_at,
                   MATCH(content, tags_text) AGAINST (${query} IN NATURAL LANGUAGE MODE) AS score
            FROM mcp_memories
            WHERE host_id = ${host.id}
              AND deleted_at IS NULL
              AND MATCH(content, tags_text) AGAINST (${query} IN NATURAL LANGUAGE MODE)
            ORDER BY score DESC, updated_at DESC
            LIMIT ${fetchLimit}`,
      );
      const rows = Array.isArray(res) ? (res[0] as unknown) : (res as unknown);
      rawResults = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    }

    const filtered: Record<string, unknown>[] = [];
    for (const r of rawResults) {
      const rowTags = this.normalizedArray(parseTags((r as { tags?: unknown }).tags ?? null));
      const includesAll = searchTags.every((t) => rowTags.includes(t));
      if (!includesAll) continue;
      const score = typeof (r as { score?: unknown }).score === 'number' ? ((r as { score: number }).score) : null;
      filtered.push(this.formatMemory(r as never, score));
      if (filtered.length >= limit) break;
    }

    await this.recordLog(host.id, 'memory.search', {
      query_length: query.length,
      limit,
      returned: filtered.length,
      tags: tags.length,
    });

    return { status: 'ok', query, limit, count: filtered.length, matches: filtered };
  }

  async delete(payload: Record<string, unknown>, host: Host): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const memoryKey = this.normalizeKey(payload['id'] ?? payload['memory_id'] ?? payload['key'], false, errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });
    if (!memoryKey) throw new ValidationError('Validation failed', { extra: { errors: { id: ['id is required'] } } });

    const rows = await this.db
      .select()
      .from(mcpMemories)
      .where(and(eq(mcpMemories.hostId, host.id), eq(mcpMemories.memoryKey, memoryKey), isNull(mcpMemories.deletedAt)))
      .limit(1);

    if (!rows[0]) {
      await this.recordLog(host.id, 'memory.delete', { id: memoryKey, status: 'missing' });
      return { status: 'missing', id: memoryKey };
    }

    await this.db.update(mcpMemories).set({ deletedAt: nowIso() }).where(eq(mcpMemories.id, rows[0].id));
    await this.recordLog(host.id, 'memory.delete', { id: memoryKey, status: 'deleted' });
    wsPublisher.publish('memory.deleted', { id: memoryKey, host_id: host.id });
    return { status: 'deleted', id: memoryKey };
  }

  formatMemory(row: Record<string, unknown>, score: number | null = null): Record<string, unknown> {
    return {
      id: row['memory_key'] ?? row['memoryKey'] ?? null,
      record_id: row['id'] !== undefined ? Number(row['id']) : null,
      host_id: row['host_id'] ?? row['hostId'] ?? null,
      host: row['host_fqdn'] ?? null,
      content: row['content'] ?? '',
      metadata: (row['metadata'] as Record<string, unknown> | null) ?? null,
      tags: parseTags(row['tags'] ?? null),
      summary: row['summary'] ?? null,
      created_at: row['created_at'] ?? row['createdAt'] ?? null,
      updated_at: row['updated_at'] ?? row['updatedAt'] ?? null,
      score: score ?? (typeof row['score'] === 'number' ? (row['score'] as number) : null),
    };
  }

  normalizeKey(value: unknown, allowNull: boolean, errors: Record<string, string[]>): string | null {
    if (value === null || value === undefined) {
      if (allowNull) return null;
      errors['id'] = (errors['id'] ?? []).concat('id is required');
      return null;
    }
    if (typeof value !== 'string') {
      errors['id'] = (errors['id'] ?? []).concat('id must be a string');
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      if (allowNull) return null;
      errors['id'] = (errors['id'] ?? []).concat('id is required');
      return null;
    }
    if (trimmed.length > 128) errors['id'] = (errors['id'] ?? []).concat('id must be 128 characters or fewer');
    if (!KEY_RE.test(trimmed)) {
      errors['id'] = (errors['id'] ?? []).concat('id may only contain letters, numbers, dots, underscores, hyphens, and colons');
    }
    if (RESERVED_COCO.test(trimmed)) {
      errors['id'] = (errors['id'] ?? []).concat(
        'ids beginning with coco are reserved for CoCo shared handoffs; use shared projects (`/projects` or `project_*`) instead of host-scoped MCP memory',
      );
    }
    return trimmed;
  }

  normalizeMetadata(value: unknown, errors: Record<string, string[]>): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors['metadata'] = (errors['metadata'] ?? []).concat('metadata must be an object');
      return null;
    }
    return value as Record<string, unknown>;
  }

  normalizeTags(value: unknown, errors: Record<string, string[]>): string[] {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) {
      errors['tags'] = (errors['tags'] ?? []).concat('tags must be an array of strings');
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const tag of value) {
      if (typeof tag !== 'string') {
        errors['tags'] = (errors['tags'] ?? []).concat('tags must be strings');
        continue;
      }
      const t = tag.trim();
      if (!t) continue;
      if (t.length > MAX_TAG_LENGTH) {
        errors['tags'] = (errors['tags'] ?? []).concat(`tag "${t}" is longer than ${MAX_TAG_LENGTH} characters`);
        continue;
      }
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    if (out.length > MAX_TAGS) {
      errors['tags'] = (errors['tags'] ?? []).concat(`no more than ${MAX_TAGS} tags allowed`);
    }
    return out;
  }

  private normalizedArray(items: string[]): string[] {
    const out = Array.from(new Set(items.map((t) => String(t).toLowerCase())));
    out.sort();
    return out;
  }

  private normalizedAssoc(value: Record<string, unknown> | null): Record<string, unknown> | null {
    if (value === null) return null;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  private async recordLog(hostId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId: hostId ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: nowIso(),
      engine: null,
    });
  }

  private generateKey(): string {
    return randomUUID();
  }
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((t) => typeof t === 'string' && t !== '') as string[];
  }
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((t) => typeof t === 'string' && t !== '');
      }
    } catch {
      return [];
    }
  }
  return [];
}
