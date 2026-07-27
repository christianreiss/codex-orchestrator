/**
 * Fleet-wide shared memory: one corpus of large documents, readable and
 * writable by every host and both engines.
 *
 * This is the third memory substrate and it exists because the other two cannot
 * do this job:
 *   - `mcp_memories` (McpMemoriesService) is keyed `(host_id, memory_key)`. Two
 *     hosts writing the same key get two unrelated rows, and nothing can list
 *     another host's keys.
 *   - `coord_project_memories` (HostProjectsService) is cross-host but requires
 *     a project, and models one short fact per key.
 *
 * Neither holds "everything the fleet knows about X" as a document you can find
 * without already knowing its key. That is what this is: slug-addressed
 * documents up to 1 MiB, chunked and FULLTEXT-indexed, discovered by `list`
 * (no query needed) and narrowed by `search`.
 *
 * Scoping note for future readers: `source_host_id` / `source_engine` are
 * provenance only. Do NOT add host or engine filters to reads — AGENTS.md's
 * "branch per engine" rule is about auth/config/binaries, and the entire point
 * of this table is that a memory written by `cdx` on one host is found by `clx`
 * on another. The `^coco` key reservation that guards `mcp_memories` does not
 * apply here either: that reservation exists to push shared state out of
 * host-scoped storage, and this IS shared storage.
 */
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { logs, sharedMemories, sharedMemoryChunks, sharedMemoryRevisions } from '../db/schema.js';
import type { Host } from '../db/schema.js';
import type { Engine } from '../util/engine.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { sha256 } from '../security/hash.js';
import { nowIso } from '../util/timestamp.js';
import { wsPublisher } from '../ws/publisher.js';
import { parseTags, sortedLowercase } from './memory-tags.js';
import { chunkContent, excerptFor, preview, type Chunk } from './shared-memory-chunker.js';

/** 1 MiB. Two orders of magnitude above the 32k both other substrates cap at. */
export const MAX_CONTENT_CHARS = 1_048_576;
export const MAX_SLUG_LENGTH = 160;
export const MAX_TITLE_LENGTH = 255;
export const MAX_SUMMARY_LENGTH = 1000;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 64;
/** Default cap on characters returned by a single `read`. */
export const DEFAULT_READ_CHARS = 32_000;
/** Ceiling on documents one `list` call will examine before filtering. */
const LIST_SCAN_CAP = 2000;
/** Caps for the degraded (no FULLTEXT index) search path. */
const FALLBACK_SCAN_DOCS = 200;
const FALLBACK_SCAN_BYTES = 8 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9][a-z0-9._:-]*$/;

export interface SharedMemorySummary {
  slug: string;
  title: string;
  summary: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  content_length: number;
  chunk_count: number;
  revision: number;
  sha256: string;
  uri: string;
  source_host_id: number | null;
  source_engine: string | null;
  created_at: string;
  updated_at: string;
  preview: string;
}

interface DocRow {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  content: string;
  contentSha256: string;
  contentLength: number;
  chunkCount: number;
  revision: number;
  metadata: Record<string, unknown> | null;
  tags: string[];
  sourceHostId: number | null;
  sourceEngine: string | null;
  createdAt: string;
  updatedAt: string;
}

export function sharedMemoryUri(slug: string, ordinal: number | null = null): string {
  const base = `shared://${encodeURIComponent(slug)}`;
  return ordinal === null ? base : `${base}#${ordinal}`;
}

export class SharedMemoriesService {
  constructor(private readonly db: Database) {}

  // ──────────────────────────────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────────────────────────────

  /**
   * The discovery entry point. Takes no query on purpose: a zero-knowledge
   * agent must be able to see what the fleet remembers before it can guess
   * search terms. `docs/skills/context.SKILL.md` disqualifies host-scoped
   * `memory_*` for exactly the lack of this call.
   */
  async list(payload: Record<string, unknown>, host: Host | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const limit = normalizeInt(payload['limit'], 50, 1, 200);
    const offset = normalizeInt(payload['offset'], 0, 0, 1_000_000);
    const tags = sortedLowercase(this.normalizeTags(payload['tags'], errors));
    const prefixRaw = payload['prefix'];
    const prefix = typeof prefixRaw === 'string' ? prefixRaw.trim().toLowerCase() : '';
    const includeContent = truthy(payload['include_content']);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    const conditions = [isNull(sharedMemories.deletedAt)];
    if (prefix !== '') conditions.push(like(sharedMemories.slug, `${escapeLike(prefix)}%`));

    // Tag filtering and offsetting both run in JS: `tags` is a JSON column with
    // no containment index, and paging with SQL OFFSET would drop tag matches
    // that fall outside the page. One bounded fetch, filtered here — `scanCap`
    // is what the listing is willing to look at, and `scanned_all` tells the
    // caller when that bound was hit.
    const scanCap = Math.min(LIST_SCAN_CAP, (offset + limit) * (tags.length > 0 ? 5 : 1) + limit);
    const rows = await this.db
      .select()
      .from(sharedMemories)
      .where(and(...conditions))
      .orderBy(desc(sharedMemories.updatedAt), desc(sharedMemories.id))
      .limit(scanCap);

    const items: SharedMemorySummary[] = [];
    let skipped = 0;
    for (const raw of rows) {
      const doc = hydrate(raw as unknown as Record<string, unknown>);
      if (tags.length > 0) {
        const rowTags = sortedLowercase(doc.tags);
        if (!tags.every((t) => rowTags.includes(t))) continue;
      }
      if (skipped < offset) {
        skipped++;
        continue;
      }
      items.push(this.summarize(doc, includeContent));
      if (items.length >= limit) break;
    }

    const total = await this.countLive();
    await this.recordLog(host, 'shared_memory.list', { limit, offset, returned: items.length, tags: tags.length, prefix: prefix !== '' });
    return {
      status: 'ok',
      limit,
      offset,
      count: items.length,
      total,
      scanned_all: rows.length < scanCap,
      memories: items,
    };
  }

  /**
   * Relevance search over chunks. `mode: 'documents'` folds the chunk hits back
   * into one entry per document (best score wins) for callers that want a
   * reading list rather than passages.
   */
  async search(payload: Record<string, unknown>, host: Host | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const query = String(payload['query'] ?? payload['q'] ?? '').trim();
    const limit = normalizeInt(payload['limit'], 10, 1, 50);
    const tags = sortedLowercase(this.normalizeTags(payload['tags'], errors));
    const modeRaw = String(payload['mode'] ?? 'chunks').trim().toLowerCase();
    if (modeRaw !== 'chunks' && modeRaw !== 'documents') {
      errors['mode'] = (errors['mode'] ?? []).concat("mode must be 'chunks' or 'documents'");
    }
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });
    const mode = modeRaw as 'chunks' | 'documents';

    if (query === '') {
      // Empty query is a recency listing, not an error — same affordance the
      // other two memory searches give.
      const listed = (await this.list({ limit, tags: payload['tags'] }, host)) as { memories: SharedMemorySummary[] };
      return {
        status: 'ok',
        query,
        mode,
        limit,
        degraded: false,
        count: listed.memories.length,
        matches: listed.memories.map((m) => ({
          slug: m.slug,
          title: m.title,
          uri: m.uri,
          chunk: null,
          heading: null,
          excerpt: m.preview,
          score: null,
          tags: m.tags,
          content_length: m.content_length,
          chunk_count: m.chunk_count,
          updated_at: m.updated_at,
        })),
      };
    }

    let degraded = false;
    // Documents mode needs several chunks per document to pick a winner, so it
    // pulls a wider net before folding.
    const perFetch = mode === 'documents' ? limit * 5 : limit * (tags.length > 0 ? 3 : 1);

    const fetchBatch = async (offset: number): Promise<Array<Record<string, unknown>>> => {
      try {
        const res = await this.db.execute(
          sql`SELECT c.memory_id, c.ordinal, c.heading, c.content AS chunk_content, c.char_start, c.char_end,
                     m.slug, m.title, m.summary, m.tags, m.content_length, m.chunk_count, m.revision, m.updated_at,
                     MATCH(c.content, c.heading, c.tags_text) AGAINST (${query} IN NATURAL LANGUAGE MODE) AS score
                FROM shared_memory_chunks c
                JOIN shared_memories m ON m.id = c.memory_id AND m.revision = c.revision
               WHERE m.deleted_at IS NULL
                 AND MATCH(c.content, c.heading, c.tags_text) AGAINST (${query} IN NATURAL LANGUAGE MODE)
               ORDER BY score DESC, m.updated_at DESC, c.id DESC
               LIMIT ${perFetch} OFFSET ${offset}`,
        );
        // mysql2 hands back [rows, fields]; drizzle's execute passes that
        // through for raw SQL. Skipping this unwrap yields zero rows forever.
        const rows = Array.isArray(res) ? (res[0] as unknown) : (res as unknown);
        return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      } catch (err) {
        // MySQL 1191 "Can't find FULLTEXT index matching the column list". The
        // index ships in 0006_add_shared_memories.sql, but nothing applies
        // migrations automatically, so a DB built by `drizzle-kit push` would
        // otherwise hard-fail every search. Fall back to a bounded substring
        // scan and tell the caller via `degraded`.
        if (!isMissingFulltextIndex(err)) throw err;
        degraded = true;
        return this.substringFallback(query, perFetch, offset);
      }
    };

    const hits: Array<Record<string, unknown>> = [];
    let offset = 0;
    const wanted = mode === 'documents' ? limit * 5 : limit;
    for (;;) {
      const batch = await fetchBatch(offset);
      for (const row of batch) {
        if (tags.length > 0) {
          const rowTags = sortedLowercase(parseTags(row['tags'] ?? null));
          if (!tags.every((t) => rowTags.includes(t))) continue;
        }
        hits.push(row);
        if (hits.length >= wanted) break;
      }
      if (hits.length >= wanted || batch.length < perFetch) break;
      offset += perFetch;
    }

    const matches = mode === 'documents' ? foldToDocuments(hits, query, limit) : hits.slice(0, limit).map((r) => chunkMatch(r, query));

    await this.recordLog(host, 'shared_memory.search', {
      query_length: query.length,
      mode,
      limit,
      returned: matches.length,
      tags: tags.length,
      degraded,
    });
    return { status: 'ok', query, mode, limit, degraded, count: matches.length, matches };
  }

  /**
   * Read a document. Returns a bounded window by default: `max_chars` (default
   * 32k) worth of text starting at `offset`, or the exact span of a requested
   * chunk range. `truncated` + `next_offset` let a caller walk a 1 MiB document
   * without ever holding all of it.
   */
  async read(payload: Record<string, unknown>, host: Host | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const slug = this.normalizeSlug(payload['slug'] ?? payload['id'] ?? payload['key'], errors);
    if (Object.keys(errors).length || !slug) {
      throw new ValidationError('Validation failed', { extra: { errors: Object.keys(errors).length ? errors : { slug: ['slug is required'] } } });
    }

    const doc = await this.findBySlug(slug);
    if (!doc) {
      await this.recordLog(host, 'shared_memory.read', { slug, status: 'missing' });
      return { status: 'missing', slug, memory: null };
    }

    const maxChars = normalizeInt(payload['max_chars'], DEFAULT_READ_CHARS, 1, MAX_CONTENT_CHARS);
    let start = normalizeInt(payload['offset'], 0, 0, MAX_CONTENT_CHARS);
    let end = Math.min(doc.content.length, start + maxChars);
    let chunkRange: { from: number; to: number } | null = null;

    const chunkParam = payload['chunk'];
    const fromChunk = payload['from_chunk'];
    const toChunk = payload['to_chunk'];
    if (chunkParam !== undefined && chunkParam !== null && chunkParam !== '') {
      const ordinal = normalizeInt(chunkParam, 0, 0, Number.MAX_SAFE_INTEGER);
      const span = await this.chunkSpan(doc, ordinal, ordinal);
      if (!span) {
        throw new ValidationError('Validation failed', { extra: { errors: { chunk: [`chunk ${ordinal} is out of range (0..${Math.max(0, doc.chunkCount - 1)})`] } } });
      }
      start = span.start;
      end = Math.min(span.end, start + maxChars);
      chunkRange = { from: ordinal, to: ordinal };
    } else if ((fromChunk !== undefined && fromChunk !== null && fromChunk !== '') || (toChunk !== undefined && toChunk !== null && toChunk !== '')) {
      const from = normalizeInt(fromChunk, 0, 0, Number.MAX_SAFE_INTEGER);
      const to = normalizeInt(toChunk, from, from, Number.MAX_SAFE_INTEGER);
      const span = await this.chunkSpan(doc, from, to);
      if (!span) {
        throw new ValidationError('Validation failed', { extra: { errors: { from_chunk: [`chunks ${from}..${to} are out of range (0..${Math.max(0, doc.chunkCount - 1)})`] } } });
      }
      start = span.start;
      end = Math.min(span.end, start + maxChars);
      chunkRange = { from, to };
    }

    if (start > doc.content.length) start = doc.content.length;
    if (end < start) end = start;
    const content = doc.content.slice(start, end);
    const truncated = end < doc.content.length;

    await this.recordLog(host, 'shared_memory.read', { slug, status: 'found', returned: content.length, truncated });
    return {
      status: 'found',
      slug,
      memory: this.summarize(doc, false),
      content,
      offset: start,
      returned_chars: content.length,
      truncated,
      next_offset: truncated ? end : null,
      chunk_range: chunkRange,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Writes
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Create or replace a document. `expected_sha256` is optimistic concurrency
   * (same affordance as `/admin/config/store`): pass the sha you read and the
   * write is rejected with a conflict if someone else moved the document
   * meanwhile. Without it, last writer wins.
   */
  async write(payload: Record<string, unknown>, host: Host | null = null, engine: Engine | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const slug = this.normalizeSlug(payload['slug'] ?? payload['id'] ?? payload['key'], errors);
    const content = this.normalizeContent(payload['content'] ?? payload['text'], errors);
    const tags = this.normalizeTags(payload['tags'], errors);
    const metadata = this.normalizeMetadata(payload['metadata'], errors);
    const title = this.normalizeTitle(payload['title'], slug, errors);
    const summary = this.normalizeSummary(payload['summary'], errors);
    if (Object.keys(errors).length || slug === null || content === null) {
      throw new ValidationError('Validation failed', {
        extra: { errors: Object.keys(errors).length ? errors : { slug: ['slug is required'] } },
      });
    }

    const existing = await this.findBySlug(slug, true);
    const expected = payload['expected_sha256'];
    if (typeof expected === 'string' && expected.trim() !== '') {
      const actual = existing && existing.deletedAtIsNull ? existing.doc.contentSha256 : null;
      if (actual !== expected.trim()) {
        throw new ConflictError(
          `shared memory "${slug}" changed since it was read (expected_sha256 ${expected.trim()}, current ${actual ?? 'absent'}); re-read before writing`,
          'shared_memory_conflict',
        );
      }
    }

    return this.persist({
      slug,
      title,
      summary,
      content,
      tags,
      metadata,
      existing,
      op: 'write',
      host,
      engine,
    });
  }

  /**
   * Grow a document without reading it first. This is the multi-writer safe
   * path: two agents appending concurrently both keep their text, where a
   * read-modify-write pair would silently drop one of them.
   */
  async append(payload: Record<string, unknown>, host: Host | null = null, engine: Engine | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const slug = this.normalizeSlug(payload['slug'] ?? payload['id'] ?? payload['key'], errors);
    const addition = this.normalizeContent(payload['content'] ?? payload['text'], errors);
    const tags = this.normalizeTags(payload['tags'], errors);
    const metadata = this.normalizeMetadata(payload['metadata'], errors);
    const headingRaw = payload['heading'];
    const heading = typeof headingRaw === 'string' && headingRaw.trim() !== '' ? headingRaw.trim() : null;
    const separatorRaw = payload['separator'];
    const separator = typeof separatorRaw === 'string' ? separatorRaw : '\n\n';
    if (Object.keys(errors).length || slug === null || addition === null) {
      throw new ValidationError('Validation failed', { extra: { errors: Object.keys(errors).length ? errors : { slug: ['slug is required'] } } });
    }

    const existing = await this.findBySlug(slug, true);
    const block = heading ? `## ${heading}\n\n${addition}` : addition;
    const base = existing && existing.deletedAtIsNull ? existing.doc.content : '';
    const merged = base === '' ? block : `${base.replace(/\s+$/, '')}${separator}${block}`;
    if (merged.length > MAX_CONTENT_CHARS) {
      throw new ValidationError('Validation failed', {
        extra: {
          errors: {
            content: [
              `appending ${addition.length} characters would exceed the ${MAX_CONTENT_CHARS}-character limit (current length ${base.length}); split the document across slugs`,
            ],
          },
        },
      });
    }

    const title = this.normalizeTitle(payload['title'], slug, errors);
    const summary = this.normalizeSummary(payload['summary'], errors);
    if (Object.keys(errors).length) throw new ValidationError('Validation failed', { extra: { errors } });

    return this.persist({
      slug,
      title: existing && existing.deletedAtIsNull && payload['title'] === undefined ? existing.doc.title : title,
      summary: summary ?? (existing && existing.deletedAtIsNull ? existing.doc.summary : null),
      content: merged,
      // Appends union tags rather than replacing them: an appending agent is
      // adding to someone else's document and should not be able to drop the
      // labels it never saw.
      tags: existing && existing.deletedAtIsNull ? unionTags(existing.doc.tags, tags) : tags,
      metadata: metadata ?? (existing && existing.deletedAtIsNull ? existing.doc.metadata : null),
      existing,
      op: 'append',
      appendedChars: merged.length - base.length,
      host,
      engine,
    });
  }

  async delete(payload: Record<string, unknown>, host: Host | null = null, engine: Engine | null = null): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const slug = this.normalizeSlug(payload['slug'] ?? payload['id'] ?? payload['key'], errors);
    if (Object.keys(errors).length || !slug) {
      throw new ValidationError('Validation failed', { extra: { errors: Object.keys(errors).length ? errors : { slug: ['slug is required'] } } });
    }

    const doc = await this.findBySlug(slug);
    if (!doc) {
      await this.recordLog(host, 'shared_memory.delete', { slug, status: 'missing' });
      return { status: 'missing', slug };
    }

    const now = nowIso();
    const revision = doc.revision + 1;
    // The revision counter has to advance on the row too, not just in the
    // ledger: a soft delete leaves the slug in place, so the next write revives
    // this same row and computes its revision from it. Leaving the row at N
    // while the ledger already holds N+1 makes that revive collide on
    // uniq_shared_memory_revision and fail the write outright.
    await this.db.update(sharedMemories).set({ deletedAt: now, updatedAt: now, revision }).where(eq(sharedMemories.id, doc.id));
    // Chunks are pure derived data; drop them so a soft-deleted document stops
    // consuming FULLTEXT index space and can never surface in a search.
    await this.db.delete(sharedMemoryChunks).where(eq(sharedMemoryChunks.memoryId, doc.id));
    await this.recordRevision(doc.id, revision, 'delete', doc.contentSha256, 0, -doc.contentLength, host, engine);
    await this.recordLog(host, 'shared_memory.delete', { slug, status: 'deleted' });
    wsPublisher.publish('shared_memory.deleted', { slug, id: doc.id });
    wsPublisher.publish('shared_memory.changed', { slug, id: doc.id });
    return { status: 'deleted', slug };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Admin
  // ──────────────────────────────────────────────────────────────────────

  async adminList(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = String(input['query'] ?? input['q'] ?? '').trim();
    if (query !== '') {
      const found = (await this.search({ query, limit: normalizeInt(input['limit'], 50, 1, 200), mode: 'documents', tags: input['tags'] })) as Record<
        string,
        unknown
      >;
      return { ...found, view: 'search' };
    }
    const listed = await this.list({ limit: normalizeInt(input['limit'], 50, 1, 200), offset: input['offset'], tags: input['tags'], prefix: input['prefix'] });
    return { ...listed, view: 'list' };
  }

  async adminDetail(slug: string): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const normalized = this.normalizeSlug(slug, errors);
    if (Object.keys(errors).length || !normalized) throw new ValidationError('Validation failed', { extra: { errors } });
    const doc = await this.findBySlug(normalized);
    if (!doc) throw new NotFoundError('Shared memory not found', 'shared_memory_not_found');
    const revisions = await this.db
      .select()
      .from(sharedMemoryRevisions)
      .where(eq(sharedMemoryRevisions.memoryId, doc.id))
      .orderBy(desc(sharedMemoryRevisions.revision))
      .limit(20);
    return {
      status: 'ok',
      memory: { ...this.summarize(doc, true), content: doc.content },
      revisions: revisions.map((r) => ({
        revision: r.revision,
        op: r.op,
        sha256: r.contentSha256,
        content_length: r.contentLength,
        delta_length: r.deltaLength,
        source_host_id: r.sourceHostId,
        source_engine: r.sourceEngine,
        note: r.note,
        created_at: r.createdAt,
      })),
    };
  }

  /**
   * Admin delete is a hard delete: it frees the slug for reuse, matching how
   * `MemoriesService.adminDelete` frees the `(host_id, memory_key)` slot.
   */
  async adminDelete(slug: string): Promise<Record<string, unknown>> {
    const errors: Record<string, string[]> = {};
    const normalized = this.normalizeSlug(slug, errors);
    if (Object.keys(errors).length || !normalized) throw new ValidationError('Validation failed', { extra: { errors } });
    const rows = await this.db.select().from(sharedMemories).where(eq(sharedMemories.slug, normalized)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError('Shared memory not found', 'shared_memory_not_found');
    await this.db.delete(sharedMemoryChunks).where(eq(sharedMemoryChunks.memoryId, row.id));
    await this.db.delete(sharedMemoryRevisions).where(eq(sharedMemoryRevisions.memoryId, row.id));
    await this.db.delete(sharedMemories).where(eq(sharedMemories.id, row.id));
    await this.recordLog(null, 'shared_memory.admin.delete', { slug: normalized, id: row.id });
    wsPublisher.publish('shared_memory.deleted', { slug: normalized, id: row.id });
    wsPublisher.publish('shared_memory.changed', { slug: normalized, id: row.id });
    return { deleted: normalized };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Resource helpers (shared://{slug})
  // ──────────────────────────────────────────────────────────────────────

  async listRecent(limit = 20): Promise<SharedMemorySummary[]> {
    const rows = await this.db
      .select()
      .from(sharedMemories)
      .where(isNull(sharedMemories.deletedAt))
      .orderBy(desc(sharedMemories.updatedAt), desc(sharedMemories.id))
      .limit(Math.max(1, Math.min(200, limit)));
    return rows.map((r) => this.summarize(hydrate(r as unknown as Record<string, unknown>), false));
  }

  async readForResource(slug: string): Promise<{ summary: SharedMemorySummary; content: string } | null> {
    const errors: Record<string, string[]> = {};
    const normalized = this.normalizeSlug(slug, errors);
    if (Object.keys(errors).length || !normalized) return null;
    const doc = await this.findBySlug(normalized);
    if (!doc) return null;
    return { summary: this.summarize(doc, false), content: doc.content };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private async persist(input: {
    slug: string;
    title: string;
    summary: string | null;
    content: string;
    tags: string[];
    metadata: Record<string, unknown> | null;
    existing: { doc: DocRow; deletedAtIsNull: boolean } | null;
    op: 'write' | 'append';
    appendedChars?: number;
    host: Host | null;
    engine: Engine | null;
  }): Promise<Record<string, unknown>> {
    const { slug, content, tags, metadata, existing, op, host, engine } = input;
    const now = nowIso();
    const digest = sha256(content);
    const tagsText = tags.length > 0 ? tags.join(' ') : null;
    const live = existing && existing.deletedAtIsNull ? existing.doc : null;

    if (live && live.contentSha256 === digest && live.title === input.title && (live.summary ?? null) === (input.summary ?? null) && sameTags(live.tags, tags) && sameMetadata(live.metadata, metadata)) {
      // Re-storing identical content writes nothing and burns no revision —
      // the same `unchanged` contract project memories give.
      return {
        status: 'unchanged',
        slug,
        memory: this.summarize(live, false),
      };
    }

    const chunks = chunkContent(content);
    let memoryId: number;
    let revision: number;
    let status: 'created' | 'updated' | 'appended';

    if (existing) {
      memoryId = existing.doc.id;
      revision = existing.doc.revision + 1;
      status = live ? (op === 'append' ? 'appended' : 'updated') : 'created';
      // Chunks for the new revision go in BEFORE the parent flips to it: reads
      // join on `chunk.revision = memory.revision`, so until that update lands
      // the new rows are invisible and the old document stays whole. A crash in
      // between leaves orphan rows, never a half-updated document.
      await this.writeChunks(memoryId, revision, chunks, tagsText, now);
      await this.db
        .update(sharedMemories)
        .set({
          title: input.title,
          summary: input.summary,
          content,
          contentSha256: digest,
          contentLength: content.length,
          chunkCount: chunks.length,
          revision,
          metadata,
          tags: tags.length > 0 ? tags : null,
          tagsText,
          sourceHostId: host?.id ?? null,
          sourceEngine: engine ?? null,
          updatedAt: now,
          deletedAt: null,
        })
        .where(eq(sharedMemories.id, memoryId));
    } else {
      revision = 1;
      status = 'created';
      const res = await this.db.insert(sharedMemories).values({
        slug,
        title: input.title,
        summary: input.summary,
        content,
        contentSha256: digest,
        contentLength: content.length,
        chunkCount: chunks.length,
        revision,
        metadata,
        tags: tags.length > 0 ? tags : null,
        tagsText,
        sourceHostId: host?.id ?? null,
        sourceEngine: engine ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      const insertId = readInsertId(res);
      if (insertId !== null) {
        memoryId = insertId;
      } else {
        const back = await this.findBySlug(slug);
        if (!back) throw new Error('shared memory insert did not persist');
        memoryId = back.id;
      }
      await this.writeChunks(memoryId, revision, chunks, tagsText, now);
    }

    await this.dropStaleChunks(memoryId, revision);

    const delta = content.length - (live?.contentLength ?? 0);
    await this.recordRevision(memoryId, revision, op === 'append' ? 'append' : live ? 'replace' : 'create', digest, content.length, delta, host, engine);
    await this.recordLog(host, `shared_memory.${op}`, {
      slug,
      status,
      revision,
      content_length: content.length,
      chunks: chunks.length,
      tags: tags.length,
    });
    wsPublisher.publish(status === 'created' ? 'shared_memory.created' : 'shared_memory.changed', { slug, id: memoryId });

    const saved = await this.findBySlug(slug);
    return {
      status,
      slug,
      revision,
      appended_chars: input.appendedChars ?? null,
      memory: saved ? this.summarize(saved, false) : null,
    };
  }

  private async writeChunks(memoryId: number, revision: number, chunks: Chunk[], tagsText: string | null, now: string): Promise<void> {
    const rows = chunks.map((c) => ({
      memoryId,
      revision,
      ordinal: c.ordinal,
      heading: c.heading,
      content: c.content,
      charStart: c.charStart,
      charEnd: c.charEnd,
      tagsText,
      createdAt: now,
    }));
    // Batched so a 500-chunk document does not become one oversized packet.
    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db.insert(sharedMemoryChunks).values(rows.slice(i, i + BATCH));
    }
  }

  /**
   * Remove chunks left behind by earlier revisions. Deletes are issued one
   * revision at a time with plain equality predicates rather than a single
   * `revision <> current`, because equality is what both MySQL and the test
   * fakes agree on — a predicate the fake cannot decode is silently dropped,
   * which here would mean deleting the chunks that were just written.
   * Normally there is exactly one stale revision, so this is one extra DELETE.
   */
  private async dropStaleChunks(memoryId: number, currentRevision: number): Promise<void> {
    const rows = await this.db
      .select({ revision: sharedMemoryChunks.revision })
      .from(sharedMemoryChunks)
      .where(eq(sharedMemoryChunks.memoryId, memoryId));
    const stale = new Set<number>();
    for (const r of rows) {
      const rev = Number((r as { revision?: unknown }).revision);
      if (Number.isFinite(rev) && rev !== currentRevision) stale.add(rev);
    }
    for (const rev of stale) {
      await this.db.delete(sharedMemoryChunks).where(and(eq(sharedMemoryChunks.memoryId, memoryId), eq(sharedMemoryChunks.revision, rev)));
    }
  }

  private async chunkSpan(doc: DocRow, from: number, to: number): Promise<{ start: number; end: number } | null> {
    if (from > to) return null;
    // No orderBy/limit: the chunk set for one revision is small and bounded by
    // MAX_CHUNKS, and sorting here keeps the query to plain equality predicates.
    const rows = await this.db
      .select()
      .from(sharedMemoryChunks)
      .where(and(eq(sharedMemoryChunks.memoryId, doc.id), eq(sharedMemoryChunks.revision, doc.revision)));
    const inRange = rows.filter((r) => r.ordinal >= from && r.ordinal <= to);
    if (inRange.length === 0) return null;
    const start = Math.min(...inRange.map((r) => r.charStart));
    const end = Math.max(...inRange.map((r) => r.charEnd));
    return { start, end };
  }

  /**
   * Search path for a database whose FULLTEXT index never got created. The
   * project-memory equivalent scans every row in the project, which is bounded
   * by project size; this corpus is fleet-wide and holds 1 MiB documents, so an
   * unbounded scan would trade a missing index for an out-of-memory. Hence the
   * document and byte caps — a degraded search is explicitly best-effort, and
   * `degraded: true` in the response says so.
   */
  private async substringFallback(query: string, limit: number, offset: number): Promise<Array<Record<string, unknown>>> {
    const needle = query.toLowerCase();
    const docs = await this.db
      .select()
      .from(sharedMemories)
      .where(isNull(sharedMemories.deletedAt))
      .orderBy(desc(sharedMemories.updatedAt), desc(sharedMemories.id))
      .limit(FALLBACK_SCAN_DOCS);

    const out: Array<Record<string, unknown>> = [];
    let scannedBytes = 0;
    for (const raw of docs) {
      if (scannedBytes > FALLBACK_SCAN_BYTES) break;
      const doc = hydrate(raw as unknown as Record<string, unknown>);
      scannedBytes += doc.content.length;
      const idx = doc.content.toLowerCase().indexOf(needle);
      const inTags = doc.tags.some((t) => t.toLowerCase().includes(needle));
      const inTitle = doc.title.toLowerCase().includes(needle);
      if (idx === -1 && !inTags && !inTitle) continue;
      // Re-derive the chunk the hit lands in rather than querying the chunk
      // table: chunking is pure, so the same content yields the same boundaries.
      const chunks = chunkContent(doc.content);
      const hitAt = idx === -1 ? 0 : idx;
      const chunk = chunks.find((c) => hitAt >= c.charStart && hitAt < c.charEnd) ?? chunks[0]!;
      out.push({
        memory_id: doc.id,
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        chunk_content: chunk.content,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
        slug: doc.slug,
        title: doc.title,
        summary: doc.summary,
        tags: doc.tags,
        content_length: doc.contentLength,
        chunk_count: doc.chunkCount,
        revision: doc.revision,
        updated_at: doc.updatedAt,
        score: null,
      });
    }
    return out.slice(offset, offset + limit);
  }

  private async findBySlug(slug: string): Promise<DocRow | null>;
  private async findBySlug(slug: string, includeDeleted: true): Promise<{ doc: DocRow; deletedAtIsNull: boolean } | null>;
  private async findBySlug(slug: string, includeDeleted = false): Promise<DocRow | { doc: DocRow; deletedAtIsNull: boolean } | null> {
    const rows = await this.db.select().from(sharedMemories).where(eq(sharedMemories.slug, slug)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const doc = hydrate(row as unknown as Record<string, unknown>);
    if (includeDeleted) return { doc, deletedAtIsNull: row.deletedAt === null || row.deletedAt === undefined };
    return row.deletedAt ? null : doc;
  }

  private async countLive(): Promise<number> {
    const rows = await this.db.select({ c: sql<number>`count(*)` }).from(sharedMemories).where(isNull(sharedMemories.deletedAt));
    return Number(rows[0]?.c ?? 0);
  }

  private summarize(doc: DocRow, includeContent: boolean): SharedMemorySummary {
    const out: SharedMemorySummary = {
      slug: doc.slug,
      title: doc.title,
      summary: doc.summary,
      tags: doc.tags,
      metadata: doc.metadata,
      content_length: doc.contentLength,
      chunk_count: doc.chunkCount,
      revision: doc.revision,
      sha256: doc.contentSha256,
      uri: sharedMemoryUri(doc.slug),
      source_host_id: doc.sourceHostId,
      source_engine: doc.sourceEngine,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      preview: doc.summary && doc.summary.trim() !== '' ? preview(doc.summary) : preview(doc.content),
    };
    if (includeContent) (out as SharedMemorySummary & { content: string }).content = doc.content;
    return out;
  }

  private async recordRevision(
    memoryId: number,
    revision: number,
    op: string,
    digest: string,
    contentLength: number,
    delta: number,
    host: Host | null,
    engine: Engine | null,
  ): Promise<void> {
    await this.db.insert(sharedMemoryRevisions).values({
      memoryId,
      revision,
      op,
      contentSha256: digest,
      contentLength,
      deltaLength: delta,
      sourceHostId: host?.id ?? null,
      sourceEngine: engine ?? null,
      note: null,
      createdAt: nowIso(),
    });
  }

  private async recordLog(host: Host | null, action: string, details: Record<string, unknown>): Promise<void> {
    await this.db.insert(logs).values({
      hostId: host?.id ?? null,
      action,
      details: JSON.stringify(details),
      createdAt: nowIso(),
      engine: null,
    });
  }

  // ── validation ────────────────────────────────────────────────────────

  normalizeSlug(value: unknown, errors: Record<string, string[]>): string | null {
    if (value === null || value === undefined || value === '') {
      errors['slug'] = (errors['slug'] ?? []).concat('slug is required');
      return null;
    }
    if (typeof value !== 'string') {
      errors['slug'] = (errors['slug'] ?? []).concat('slug must be a string');
      return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed === '') {
      errors['slug'] = (errors['slug'] ?? []).concat('slug is required');
      return null;
    }
    if (trimmed.length > MAX_SLUG_LENGTH) {
      errors['slug'] = (errors['slug'] ?? []).concat(`slug must be ${MAX_SLUG_LENGTH} characters or fewer`);
    }
    if (!SLUG_RE.test(trimmed)) {
      errors['slug'] = (errors['slug'] ?? []).concat(
        'slug must start with a letter or digit and may only contain lowercase letters, digits, dots, underscores, hyphens, and colons',
      );
    }
    return errors['slug'] ? null : trimmed;
  }

  private normalizeContent(value: unknown, errors: Record<string, string[]>): string | null {
    if (value === null || value === undefined) {
      errors['content'] = (errors['content'] ?? []).concat('content is required');
      return null;
    }
    if (typeof value !== 'string') {
      errors['content'] = (errors['content'] ?? []).concat('content must be a string');
      return null;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      errors['content'] = (errors['content'] ?? []).concat('content is required');
      return null;
    }
    if (trimmed.length > MAX_CONTENT_CHARS) {
      errors['content'] = (errors['content'] ?? []).concat(`content must be ${MAX_CONTENT_CHARS} characters or fewer`);
      return null;
    }
    return trimmed;
  }

  private normalizeTitle(value: unknown, slug: string | null, errors: Record<string, string[]>): string {
    if (value === null || value === undefined || value === '') return slug ?? '';
    if (typeof value !== 'string') {
      errors['title'] = (errors['title'] ?? []).concat('title must be a string');
      return slug ?? '';
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_TITLE_LENGTH) {
      errors['title'] = (errors['title'] ?? []).concat(`title must be ${MAX_TITLE_LENGTH} characters or fewer`);
    }
    return trimmed === '' ? (slug ?? '') : trimmed;
  }

  private normalizeSummary(value: unknown, errors: Record<string, string[]>): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') {
      errors['summary'] = (errors['summary'] ?? []).concat('summary must be a string');
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_SUMMARY_LENGTH) {
      errors['summary'] = (errors['summary'] ?? []).concat(`summary must be ${MAX_SUMMARY_LENGTH} characters or fewer`);
      return null;
    }
    return trimmed === '' ? null : trimmed;
  }

  private normalizeMetadata(value: unknown, errors: Record<string, string[]>): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors['metadata'] = (errors['metadata'] ?? []).concat('metadata must be an object');
      return null;
    }
    return value as Record<string, unknown>;
  }

  private normalizeTags(value: unknown, errors: Record<string, string[]>): string[] {
    if (value === null || value === undefined) return [];
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(/[,\s]+/)
        : null;
    if (raw === null) {
      errors['tags'] = (errors['tags'] ?? []).concat('tags must be an array of strings');
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const tag of raw) {
      if (typeof tag !== 'string') {
        errors['tags'] = (errors['tags'] ?? []).concat('tags must be strings');
        continue;
      }
      const t = tag.trim();
      if (t === '') continue;
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
}

// ── module-local helpers ─────────────────────────────────────────────────

function hydrate(row: Record<string, unknown>): DocRow {
  const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
  const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  const nullableStr = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const metadataRaw = row['metadata'];
  let metadata: Record<string, unknown> | null = null;
  if (metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)) metadata = metadataRaw as Record<string, unknown>;
  else if (typeof metadataRaw === 'string' && metadataRaw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: num(row['id']),
    slug: str(row['slug']),
    title: str(row['title']),
    summary: nullableStr(row['summary']),
    content: str(row['content']),
    contentSha256: str(row['contentSha256'] ?? row['content_sha256']),
    contentLength: num(row['contentLength'] ?? row['content_length']),
    chunkCount: num(row['chunkCount'] ?? row['chunk_count']),
    revision: num(row['revision']),
    metadata,
    tags: parseTags(row['tags'] ?? null),
    sourceHostId: row['sourceHostId'] ?? row['source_host_id'] ? Number(row['sourceHostId'] ?? row['source_host_id']) : null,
    sourceEngine: nullableStr(row['sourceEngine'] ?? row['source_engine']),
    createdAt: str(row['createdAt'] ?? row['created_at']),
    updatedAt: str(row['updatedAt'] ?? row['updated_at']),
  };
}

function chunkMatch(row: Record<string, unknown>, query: string): Record<string, unknown> {
  const slug = String(row['slug'] ?? '');
  const ordinalRaw = row['ordinal'];
  const ordinal = ordinalRaw === null || ordinalRaw === undefined ? null : Number(ordinalRaw);
  return {
    slug,
    title: row['title'] ?? null,
    uri: sharedMemoryUri(slug, ordinal),
    chunk: ordinal,
    heading: row['heading'] ?? null,
    excerpt: excerptFor(String(row['chunk_content'] ?? ''), query),
    score: typeof row['score'] === 'number' ? row['score'] : row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
    tags: parseTags(row['tags'] ?? null),
    char_start: row['char_start'] ?? null,
    char_end: row['char_end'] ?? null,
    content_length: row['content_length'] === undefined ? null : Number(row['content_length']),
    chunk_count: row['chunk_count'] === undefined ? null : Number(row['chunk_count']),
    updated_at: row['updated_at'] ?? null,
  };
}

function foldToDocuments(hits: Array<Record<string, unknown>>, query: string, limit: number): Array<Record<string, unknown>> {
  const byDoc = new Map<string, Record<string, unknown>>();
  for (const row of hits) {
    const slug = String(row['slug'] ?? '');
    if (slug === '') continue;
    const score = typeof row['score'] === 'number' ? row['score'] : row['score'] === null || row['score'] === undefined ? 0 : Number(row['score']);
    const hit = {
      chunk: row['ordinal'] === null || row['ordinal'] === undefined ? null : Number(row['ordinal']),
      heading: row['heading'] ?? null,
      excerpt: excerptFor(String(row['chunk_content'] ?? ''), query),
      score: typeof row['score'] === 'number' ? row['score'] : row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
    };
    const found = byDoc.get(slug);
    if (found) {
      found['score'] = Math.max(Number(found['score'] ?? 0), score);
      const list = found['hits'] as Array<unknown>;
      if (list.length < 3) list.push(hit);
      continue;
    }
    byDoc.set(slug, {
      slug,
      title: row['title'] ?? null,
      summary: row['summary'] ?? null,
      uri: sharedMemoryUri(slug),
      score,
      tags: parseTags(row['tags'] ?? null),
      content_length: row['content_length'] === undefined ? null : Number(row['content_length']),
      chunk_count: row['chunk_count'] === undefined ? null : Number(row['chunk_count']),
      updated_at: row['updated_at'] ?? null,
      hits: [hit],
    });
  }
  return Array.from(byDoc.values())
    .sort((a, b) => Number(b['score'] ?? 0) - Number(a['score'] ?? 0))
    .slice(0, limit);
}

function unionTags(existing: string[], added: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map((t) => t.toLowerCase()));
  for (const t of added) {
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

function sameTags(a: string[], b: string[]): boolean {
  return JSON.stringify(sortedLowercase(a)) === JSON.stringify(sortedLowercase(b));
}

function sameMetadata(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  const norm = (v: Record<string, unknown> | null) => (v === null ? null : Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  let n: number;
  if (typeof value === 'number') n = Math.trunc(value);
  else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Math.trunc(Number(value));
  else return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (m) => '\\' + m);
}

/**
 * mysql2 returns `[ResultSetHeader, fields]` for INSERT; drizzle's mysql2
 * driver hands back the header directly for `.insert()`. Accept both, and
 * report null when neither shape carries an id so the caller can re-read.
 */
function readInsertId(res: unknown): number | null {
  const pick = (candidate: unknown): number | null => {
    if (!candidate || typeof candidate !== 'object') return null;
    const id = (candidate as { insertId?: unknown }).insertId;
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) return id;
    if (typeof id === 'string' && /^\d+$/.test(id) && Number(id) > 0) return Number(id);
    return null;
  };
  if (Array.isArray(res)) {
    for (const entry of res) {
      const found = pick(entry);
      if (found !== null) return found;
    }
    return null;
  }
  return pick(res);
}

function isMissingFulltextIndex(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && depth < 5; depth++) {
    const e = cur as { errno?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (e.errno === 1191 || e.code === 'ER_FT_MATCHING_KEY_NOT_FOUND') return true;
    if (/can't find fulltext index/i.test(String(e.message ?? ''))) return true;
    cur = e.cause;
  }
  return false;
}
