/**
 * Unit coverage for the fleet-wide shared memory service.
 *
 * What the db fake can and cannot prove, so nobody reads more into a green run
 * than is there: it has no unique index, no FULLTEXT, no ordering, and no
 * `execute`. So uniqueness, MATCH ranking and ORDER BY are asserted in
 * `test/integration/shared-memories/db.test.ts` against real MySQL; here we
 * cover validation, write/append/unchanged/conflict semantics, chunk
 * bookkeeping, read windowing, and the degraded-search fallback (with
 * `execute` monkey-patched, the same way host-projects-memories.test.ts does).
 */
import { describe, it, expect } from 'vitest';
import { logs, sharedMemories, sharedMemoryChunks, sharedMemoryRevisions } from '../../../src/db/schema.js';
import { MAX_CONTENT_CHARS, SharedMemoriesService } from '../../../src/services/shared-memories.js';
import { createDbFake, type DbFake } from '../../helpers/db-fake.js';
import type { Host } from '../../../src/db/schema.js';

const host: Host = { id: 3, fqdn: 'alpha.example' } as unknown as Host;
const otherHost: Host = { id: 9, fqdn: 'beta.example' } as unknown as Host;

interface DocSeed {
  id?: number;
  slug: string;
  title?: string;
  summary?: string | null;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  revision?: number;
  deletedAt?: string | null;
  updatedAt?: string;
  sourceHostId?: number | null;
}

function makeDb(docs: DocSeed[] = []): DbFake {
  const db = createDbFake();
  db.tables.set(logs, []);
  db.tables.set(sharedMemoryChunks, []);
  db.tables.set(sharedMemoryRevisions, []);
  db.tables.set(
    sharedMemories,
    docs.map((d, i) => ({
      id: d.id ?? i + 1,
      slug: d.slug,
      title: d.title ?? d.slug,
      summary: d.summary ?? null,
      content: d.content,
      contentSha256: 'seeded-sha',
      contentLength: d.content.length,
      chunkCount: 1,
      revision: d.revision ?? 1,
      metadata: d.metadata ?? null,
      tags: d.tags ?? null,
      tagsText: d.tags?.join(' ') ?? null,
      sourceHostId: d.sourceHostId ?? 1,
      sourceEngine: null,
      createdAt: '2026-07-01T09:00:00Z',
      updatedAt: d.updatedAt ?? '2026-07-01T09:00:00Z',
      deletedAt: d.deletedAt ?? null,
    })),
  );
  return db;
}

function service(db: DbFake): SharedMemoriesService {
  return new SharedMemoriesService(db as never);
}

function chunkRowsFor(db: DbFake, memoryId: number): Array<Record<string, unknown>> {
  return (db.tables.get(sharedMemoryChunks) ?? []).filter((r) => r['memoryId'] === memoryId);
}

/**
 * ValidationError's message is always the generic "Validation failed"; the
 * per-field detail lives in `extra.errors`, which is what a caller actually
 * reads. Assert against that rather than the message.
 */
async function fieldErrors(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const extra = (err as { extra?: { errors?: Record<string, string[]> } }).extra;
    return JSON.stringify(extra?.errors ?? {});
  }
  throw new Error('expected the call to reject');
}

describe('SharedMemoriesService.write', () => {
  it('creates a document, its chunks and a revision row', async () => {
    const db = makeDb();
    const out = (await service(db).write(
      { slug: 'Ops.Crane', content: '# Crane\n\nDeploys are manual.', title: 'Crane deploys', tags: ['Ops', 'deploy'] },
      host,
      'codex',
    )) as Record<string, unknown>;

    expect(out['status']).toBe('created');
    expect(out['slug']).toBe('ops.crane');
    const memory = out['memory'] as Record<string, unknown>;
    expect(memory['title']).toBe('Crane deploys');
    expect(memory['uri']).toBe('shared://ops.crane');
    expect(memory['tags']).toEqual(['Ops', 'deploy']);

    const stored = (db.tables.get(sharedMemories) ?? [])[0]!;
    expect(stored['slug']).toBe('ops.crane');
    expect(stored['revision']).toBe(1);
    expect(stored['sourceHostId']).toBe(3);
    expect(stored['sourceEngine']).toBe('codex');
    expect(stored['tagsText']).toBe('Ops deploy');

    expect(chunkRowsFor(db, Number(stored['id'])).length).toBeGreaterThan(0);
    expect(db.tables.get(sharedMemoryRevisions)).toHaveLength(1);
    expect((db.tables.get(sharedMemoryRevisions) ?? [])[0]!['op']).toBe('create');
  });

  it('lower-cases the slug so a case-insensitive unique index cannot surprise callers', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'MixedCase', content: 'body' }, host);
    expect((db.tables.get(sharedMemories) ?? [])[0]!['slug']).toBe('mixedcase');
  });

  it('defaults the title to the slug', async () => {
    const db = makeDb();
    const out = (await service(db).write({ slug: 'notes', content: 'body' }, host)) as {
      memory: Record<string, unknown>;
    };
    expect(out.memory['title']).toBe('notes');
  });

  it('reports unchanged and writes no revision when re-storing identical content', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'a', content: 'same body', title: 'a' }, host);
    const revisionsAfterFirst = (db.tables.get(sharedMemoryRevisions) ?? []).length;

    const out = (await service(db).write({ slug: 'a', content: 'same body', title: 'a' }, otherHost)) as Record<string, unknown>;

    expect(out['status']).toBe('unchanged');
    expect((db.tables.get(sharedMemoryRevisions) ?? []).length).toBe(revisionsAfterFirst);
  });

  it('is writable by any host — a second host replaces the first host’s document', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'shared', content: 'first' }, host);
    const out = (await service(db).write({ slug: 'shared', content: 'second' }, otherHost)) as Record<string, unknown>;

    expect(out['status']).toBe('updated');
    const rows = (db.tables.get(sharedMemories) ?? []).filter((r) => r['slug'] === 'shared');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['content']).toBe('second');
    expect(rows[0]!['sourceHostId']).toBe(9);
    expect(rows[0]!['revision']).toBe(2);
  });

  it('replaces the chunk set on rewrite instead of accumulating revisions', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'alpha '.repeat(900) }, host);
    const memoryId = Number((db.tables.get(sharedMemories) ?? [])[0]!['id']);
    const firstCount = chunkRowsFor(db, memoryId).length;
    expect(firstCount).toBeGreaterThan(1);

    await service(db).write({ slug: 'doc', content: 'beta' }, host);
    const remaining = chunkRowsFor(db, memoryId);
    expect(remaining).toHaveLength(1);
    expect(remaining.every((r) => r['revision'] === 2)).toBe(true);
    expect(remaining[0]!['content']).toBe('beta');
  });

  it('rejects a write whose expected_sha256 no longer matches', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'v1' }, host);
    await expect(service(db).write({ slug: 'doc', content: 'v2', expected_sha256: 'stale-sha' }, otherHost)).rejects.toThrow(
      /changed since it was read/i,
    );
    expect((db.tables.get(sharedMemories) ?? [])[0]!['content']).toBe('v1');
  });

  it('accepts a write whose expected_sha256 matches the stored digest', async () => {
    const db = makeDb();
    const created = (await service(db).write({ slug: 'doc', content: 'v1' }, host)) as { memory: Record<string, unknown> };
    const out = (await service(db).write(
      { slug: 'doc', content: 'v2', expected_sha256: created.memory['sha256'] },
      otherHost,
    )) as Record<string, unknown>;
    expect(out['status']).toBe('updated');
  });

  it('rejects expected_sha256 on a slug that does not exist yet', async () => {
    const db = makeDb();
    await expect(service(db).write({ slug: 'nope', content: 'x', expected_sha256: 'abc' }, host)).rejects.toThrow(/current absent/);
  });

  it.each([
    ['a missing slug', { content: 'body' }],
    ['a slug with illegal characters', { slug: 'has spaces', content: 'body' }],
    ['a slug starting with punctuation', { slug: '-leading', content: 'body' }],
    ['a slug with a slash', { slug: 'ops/crane', content: 'body' }],
    ['missing content', { slug: 'ok' }],
    ['blank content', { slug: 'ok', content: '   ' }],
    ['non-object metadata', { slug: 'ok', content: 'b', metadata: 'nope' }],
    ['non-string tags', { slug: 'ok', content: 'b', tags: [1, 2] }],
  ])('rejects %s', async (_label, payload) => {
    await expect(service(makeDb()).write(payload as Record<string, unknown>, host)).rejects.toThrow(/Validation failed/);
  });

  it('rejects a document over the 1 MiB limit', async () => {
    expect(await fieldErrors(service(makeDb()).write({ slug: 'big', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }, host))).toMatch(
      /1048576 characters or fewer/,
    );
  });

  // `resources/update shared://{slug}` can only carry text. Blanking unsupplied
  // fields there silently stripped a document's title, summary and tags.
  it('preserves labels a replace did not supply', async () => {
    const db = makeDb();
    await service(db).write(
      { slug: 'doc', content: 'v1', title: 'Crane deploy runbook', summary: 'how crane ships', tags: ['ops'], metadata: { owner: 'sre' } },
      host,
    );
    await service(db).write({ slug: 'doc', content: 'v2' }, otherHost);

    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    expect(row['content']).toBe('v2');
    expect(row['title']).toBe('Crane deploy runbook');
    expect(row['summary']).toBe('how crane ships');
    expect(row['tags']).toEqual(['ops']);
    expect(row['metadata']).toEqual({ owner: 'sre' });
  });

  it('still replaces labels that ARE supplied', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'v1', title: 'Old', tags: ['ops'] }, host);
    await service(db).write({ slug: 'doc', content: 'v2', title: 'New', tags: ['deploy'] }, otherHost);
    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    expect(row['title']).toBe('New');
    expect(row['tags']).toEqual(['deploy']);
  });

  it('does not reserve the coco namespace — this IS the shared substrate', async () => {
    const out = (await service(makeDb()).write({ slug: 'coco.handoff', content: 'body' }, host)) as Record<string, unknown>;
    expect(out['status']).toBe('created');
  });
});

describe('SharedMemoriesService.append', () => {
  it('creates the document when the slug is new', async () => {
    const db = makeDb();
    const out = (await service(db).append({ slug: 'log', content: 'first entry' }, host)) as Record<string, unknown>;
    expect(out['status']).toBe('created');
    expect((db.tables.get(sharedMemories) ?? [])[0]!['content']).toBe('first entry');
  });

  it('keeps both writers’ text when two hosts append', async () => {
    const db = makeDb();
    await service(db).append({ slug: 'log', content: 'from alpha' }, host);
    const out = (await service(db).append({ slug: 'log', content: 'from beta' }, otherHost)) as Record<string, unknown>;

    expect(out['status']).toBe('appended');
    const body = String((db.tables.get(sharedMemories) ?? [])[0]!['content']);
    expect(body).toContain('from alpha');
    expect(body).toContain('from beta');
    expect(out['appended_chars']).toBe(body.length - 'from alpha'.length);
  });

  it('prefixes an optional heading', async () => {
    const db = makeDb();
    await service(db).append({ slug: 'log', content: 'entry', heading: '2026-07-27' }, host);
    expect(String((db.tables.get(sharedMemories) ?? [])[0]!['content'])).toBe('## 2026-07-27\n\nentry');
  });

  it('unions tags rather than replacing the ones it never saw', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'log', content: 'body', tags: ['ops'] }, host);
    await service(db).append({ slug: 'log', content: 'more', tags: ['incident'] }, otherHost);
    expect((db.tables.get(sharedMemories) ?? [])[0]!['tags']).toEqual(['ops', 'incident']);
  });

  it('preserves labels and metadata through the admin already-locked content-only seam', async () => {
    const db = makeDb();
    await service(db).write(
      { slug: 'log', content: 'body', title: 'Incident log', summary: 'timeline', tags: ['ops'], metadata: { owner: 'sre' } },
      host,
    );
    await new SharedMemoriesService(db as never, { publishEvents: false }).appendAlreadyLocked(
      { slug: 'log', content: 'more' },
      null,
      'codex',
    );

    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    expect(row['content']).toBe('body\n\nmore');
    expect(row['title']).toBe('Incident log');
    expect(row['summary']).toBe('timeline');
    expect(row['tags']).toEqual(['ops']);
    expect(row['metadata']).toEqual({ owner: 'sre' });
  });

  it('preserves the existing title when the appender does not supply one', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'log', content: 'body', title: 'Incident log' }, host);
    await service(db).append({ slug: 'log', content: 'more' }, otherHost);
    expect((db.tables.get(sharedMemories) ?? [])[0]!['title']).toBe('Incident log');
  });

  // `title: null` used to fall through to "default the title to the slug", so an
  // append that passed an explicit null renamed someone else's document.
  it.each([
    ['omitted', {}],
    ['explicit null', { title: null }],
    ['empty string', { title: '' }],
    ['whitespace only', { title: '   ' }],
  ])('preserves the existing title when the appender supplies %s', async (_label, extra) => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'body', title: 'Crane deploy runbook', summary: 'the summary' }, host);
    await service(db).append({ slug: 'doc', content: 'more', ...extra }, otherHost);

    const row = (db.tables.get(sharedMemories) ?? [])[0]!;
    expect(row['title']).toBe('Crane deploy runbook');
    expect(row['summary']).toBe('the summary');
  });

  it('adopts a title the appender does supply', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'body', title: 'Old' }, host);
    await service(db).append({ slug: 'doc', content: 'more', title: 'New' }, otherHost);
    expect((db.tables.get(sharedMemories) ?? [])[0]!['title']).toBe('New');
  });

  it('refuses an append that would push the document past the size limit', async () => {
    const db = makeDb([{ slug: 'big', content: 'x'.repeat(MAX_CONTENT_CHARS - 10) }]);
    expect(await fieldErrors(service(db).append({ slug: 'big', content: 'y'.repeat(100) }, host))).toMatch(/would exceed/);
  });
});

describe('SharedMemoriesService.read', () => {
  it('returns missing for an unknown slug rather than throwing', async () => {
    const out = (await service(makeDb()).read({ slug: 'nope' }, host)) as Record<string, unknown>;
    expect(out).toMatchObject({ status: 'missing', slug: 'nope', memory: null });
  });

  it('returns the whole document when it fits under max_chars', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'short body' }, host);
    const out = (await service(db).read({ slug: 'doc' }, host)) as Record<string, unknown>;
    expect(out['content']).toBe('short body');
    expect(out['truncated']).toBe(false);
    expect(out['next_offset']).toBeNull();
  });

  it('truncates a large document and hands back a resumable offset', async () => {
    const db = makeDb();
    const body = 'paragraph text. '.repeat(5000);
    await service(db).write({ slug: 'big', content: body }, host);

    const first = (await service(db).read({ slug: 'big', max_chars: 1000 }, host)) as Record<string, unknown>;
    expect(String(first['content'])).toHaveLength(1000);
    expect(first['truncated']).toBe(true);
    expect(first['next_offset']).toBe(1000);

    const second = (await service(db).read({ slug: 'big', offset: first['next_offset'], max_chars: 1000 }, host)) as Record<
      string,
      unknown
    >;
    expect(String(first['content']) + String(second['content'])).toBe(body.slice(0, 2000));
  });

  it('reads an exact chunk and a chunk range', async () => {
    const db = makeDb();
    const body = 'alpha '.repeat(900);
    await service(db).write({ slug: 'doc', content: body }, host);

    const one = (await service(db).read({ slug: 'doc', chunk: 1, max_chars: MAX_CONTENT_CHARS }, host)) as Record<string, unknown>;
    expect(one['chunk_range']).toEqual({ from: 1, to: 1 });
    expect(String(one['content']).length).toBeGreaterThan(0);
    expect(body.slice(Number(one['offset']))).toContain(String(one['content']));

    const range = (await service(db).read({ slug: 'doc', from_chunk: 0, to_chunk: 1, max_chars: MAX_CONTENT_CHARS }, host)) as Record<
      string,
      unknown
    >;
    expect(String(range['content']).length).toBeGreaterThan(String(one['content']).length);
  });

  it('rejects a chunk ordinal outside the document', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'tiny' }, host);
    expect(await fieldErrors(service(db).read({ slug: 'doc', chunk: 99 }, host))).toMatch(/out of range/);
  });

  it('treats a soft-deleted document as missing', async () => {
    const db = makeDb([{ slug: 'gone', content: 'body', deletedAt: '2026-07-02T00:00:00Z' }]);
    const out = (await service(db).read({ slug: 'gone' }, host)) as Record<string, unknown>;
    expect(out['status']).toBe('missing');
  });
});

describe('SharedMemoriesService.list', () => {
  it('needs no query — it is the discovery entry point', async () => {
    const db = makeDb([
      { slug: 'a', content: 'alpha body', tags: ['ops'] },
      { slug: 'b', content: 'beta body', tags: ['ops', 'deploy'] },
    ]);
    const out = (await service(db).list({}, host)) as { count: number; memories: Array<Record<string, unknown>> };
    expect(out.count).toBe(2);
    expect(out.memories.map((m) => m['slug']).sort()).toEqual(['a', 'b']);
    expect(out.memories[0]!['preview']).toBeTruthy();
    expect(out.memories[0]!).not.toHaveProperty('content');
  });

  it('prefers the summary over the body for the preview', async () => {
    const db = makeDb([{ slug: 'a', content: 'long body text', summary: 'one-line summary' }]);
    const out = (await service(db).list({}, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories[0]!['preview']).toBe('one-line summary');
  });

  it('AND-filters by tags', async () => {
    const db = makeDb([
      { slug: 'a', content: 'x', tags: ['ops', 'deploy'] },
      { slug: 'b', content: 'y', tags: ['ops'] },
    ]);
    const out = (await service(db).list({ tags: ['ops', 'deploy'] }, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories.map((m) => m['slug'])).toEqual(['a']);
  });

  it('hides soft-deleted documents', async () => {
    const db = makeDb([
      { slug: 'live', content: 'x' },
      { slug: 'dead', content: 'y', deletedAt: '2026-07-02T00:00:00Z' },
    ]);
    const out = (await service(db).list({}, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories.map((m) => m['slug'])).toEqual(['live']);
  });

  it('inlines content when asked', async () => {
    const db = makeDb([{ slug: 'a', content: 'the body' }]);
    const out = (await service(db).list({ include_content: true }, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories[0]!['content']).toBe('the body');
  });

  it('applies offset in JS so tag filtering cannot drop matches', async () => {
    // Seeded in the order the fake returns them: orderBy is a no-op there, so
    // the assertion is about offset arithmetic, not about SQL ordering.
    const db = makeDb([
      { slug: 'a', content: 'x' },
      { slug: 'b', content: 'y' },
      { slug: 'c', content: 'z' },
    ]);
    const out = (await service(db).list({ offset: 1, limit: 1 }, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0]!['slug']).toBe('b');
  });
});

describe('SharedMemoriesService.search', () => {
  const ftRow = (over: Record<string, unknown> = {}) => ({
    memory_id: 1,
    ordinal: 0,
    heading: 'Crane',
    chunk_content: 'crane deploys are manual and run from the FQDN',
    char_start: 0,
    char_end: 45,
    slug: 'ops.crane',
    title: 'Crane deploys',
    summary: null,
    tags: ['ops'],
    content_length: 45,
    chunk_count: 1,
    revision: 1,
    updated_at: '2026-07-01T09:00:00Z',
    score: 1.5,
    ...over,
  });

  it('unwraps the mysql2 [rows, fields] shape from db.execute', async () => {
    const db = makeDb();
    (db as unknown as { execute: () => Promise<unknown> }).execute = async () => [[ftRow()], []];
    const out = (await service(db).search({ query: 'crane' }, host)) as {
      degraded: boolean;
      count: number;
      matches: Array<Record<string, unknown>>;
    };

    expect(out.degraded).toBe(false);
    expect(out.count).toBe(1);
    expect(out.matches[0]).toMatchObject({ slug: 'ops.crane', chunk: 0, heading: 'Crane', score: 1.5 });
    expect(out.matches[0]!['uri']).toBe('shared://ops.crane#0');
    expect(String(out.matches[0]!['excerpt'])).toContain('crane');
  });

  it('folds chunk hits into one entry per document in documents mode', async () => {
    const db = makeDb();
    (db as unknown as { execute: () => Promise<unknown> }).execute = async () => [
      [ftRow({ ordinal: 0, score: 2 }), ftRow({ ordinal: 4, score: 5 }), ftRow({ slug: 'other', ordinal: 1, score: 1 })],
    ];
    const out = (await service(db).search({ query: 'crane', mode: 'documents' }, host)) as {
      matches: Array<Record<string, unknown>>;
    };

    expect(out.matches).toHaveLength(2);
    expect(out.matches[0]!['slug']).toBe('ops.crane');
    expect(out.matches[0]!['score']).toBe(5);
    expect(out.matches[0]!['uri']).toBe('shared://ops.crane');
    expect((out.matches[0]!['hits'] as unknown[]).length).toBe(2);
  });

  it('AND-filters full-text hits by tag', async () => {
    const db = makeDb();
    (db as unknown as { execute: () => Promise<unknown> }).execute = async () => [
      [ftRow({ tags: ['ops'] }), ftRow({ slug: 'other', tags: ['ops', 'deploy'] })],
    ];
    const out = (await service(db).search({ query: 'crane', tags: ['deploy'] }, host)) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(out.matches.map((m) => m['slug'])).toEqual(['other']);
  });

  it('treats an empty query as a recency listing, not a degraded search', async () => {
    const db = makeDb([{ slug: 'a', content: 'alpha' }]);
    // No `execute` on the fake: an empty query must never reach the FULLTEXT path.
    const out = (await service(db).search({ query: '   ' }, host)) as {
      degraded: boolean;
      matches: Array<Record<string, unknown>>;
    };
    expect(out.degraded).toBe(false);
    expect(out.matches[0]).toMatchObject({ slug: 'a', chunk: null, score: null });
  });

  it('degrades to a bounded substring scan when the fulltext index is missing', async () => {
    const db = makeDb([{ slug: 'ops.crane', content: '# Crane\n\ncrane deploys are manual', tags: ['ops'] }]);
    (db as unknown as { execute: () => Promise<never> }).execute = async () => {
      throw Object.assign(new Error('Failed query: SELECT ... MATCH(c.content, c.heading, c.tags_text) ...'), {
        cause: Object.assign(new Error("Can't find FULLTEXT index matching the column list"), {
          errno: 1191,
          code: 'ER_FT_MATCHING_KEY_NOT_FOUND',
        }),
      });
    };

    const out = (await service(db).search({ query: 'deploys' }, host)) as {
      degraded: boolean;
      count: number;
      matches: Array<Record<string, unknown>>;
    };

    expect(out.degraded).toBe(true);
    expect(out.count).toBe(1);
    expect(out.matches[0]!['slug']).toBe('ops.crane');
    expect(out.matches[0]!['score']).toBeNull();
  });

  it('propagates unrelated query errors instead of mislabelling them degraded', async () => {
    const db = makeDb([{ slug: 'a', content: 'body' }]);
    (db as unknown as { execute: () => Promise<never> }).execute = async () => {
      throw Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error("Table 'shared_memory_chunks' doesn't exist"), { errno: 1146, code: 'ER_NO_SUCH_TABLE' }),
      });
    };
    await expect(service(db).search({ query: 'body' }, host)).rejects.toThrow();
  });

  it('rejects an unknown mode', async () => {
    await expect(service(makeDb()).search({ query: 'x', mode: 'sideways' }, host)).rejects.toThrow(/Validation failed/);
  });
});

describe('SharedMemoriesService.delete', () => {
  it('soft-deletes the document and drops its chunks', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'body' }, host);
    const memoryId = Number((db.tables.get(sharedMemories) ?? [])[0]!['id']);

    const out = (await service(db).delete({ slug: 'doc' }, host)) as Record<string, unknown>;

    expect(out).toMatchObject({ status: 'deleted', slug: 'doc' });
    expect((db.tables.get(sharedMemories) ?? [])[0]!['deletedAt']).toBeTruthy();
    expect(chunkRowsFor(db, memoryId)).toHaveLength(0);
  });

  it('reports missing without throwing', async () => {
    const out = (await service(makeDb()).delete({ slug: 'nope' }, host)) as Record<string, unknown>;
    expect(out).toMatchObject({ status: 'missing', slug: 'nope' });
  });

  it('lets a later write revive a soft-deleted slug', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'body' }, host);
    await service(db).delete({ slug: 'doc' }, host);
    const out = (await service(db).write({ slug: 'doc', content: 'new body' }, host)) as Record<string, unknown>;

    expect(out['status']).toBe('created');
    const rows = (db.tables.get(sharedMemories) ?? []).filter((r) => r['slug'] === 'doc');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['deletedAt']).toBeNull();
  });
});

describe('SharedMemoriesService admin surface', () => {
  it('hard-deletes so the slug can be reused', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'body' }, host);
    const out = (await service(db).adminDelete('doc')) as Record<string, unknown>;
    expect(out).toEqual({ deleted: 'doc' });
    expect(db.tables.get(sharedMemories)).toHaveLength(0);
    expect(db.tables.get(sharedMemoryChunks)).toHaveLength(0);
    expect(db.tables.get(sharedMemoryRevisions)).toHaveLength(0);
  });

  it('404s on an unknown slug', async () => {
    await expect(service(makeDb()).adminDelete('nope')).rejects.toThrow(/not found/i);
  });

  it('returns full content plus the revision trail in detail', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'doc', content: 'v1' }, host);
    await service(db).write({ slug: 'doc', content: 'v2' }, otherHost);

    const out = (await service(db).adminDetail('doc')) as {
      memory: Record<string, unknown>;
      revisions: Array<Record<string, unknown>>;
    };
    expect(out.memory['content']).toBe('v2');
    expect(out.revisions).toHaveLength(2);
    expect(out.revisions.map((r) => r['op']).sort()).toEqual(['create', 'replace']);
  });
});

describe('provenance', () => {
  it('records the writing host and engine without scoping reads to them', async () => {
    const db = makeDb();
    await service(db).write({ slug: 'from-codex', content: 'a' }, host, 'codex');
    await service(db).write({ slug: 'from-claude', content: 'b' }, otherHost, 'claude');

    const out = (await service(db).list({}, host)) as { memories: Array<Record<string, unknown>> };
    expect(out.memories).toHaveLength(2);
    const bySlug = Object.fromEntries(out.memories.map((m) => [m['slug'], m]));
    expect(bySlug['from-codex']!['source_engine']).toBe('codex');
    expect(bySlug['from-claude']!['source_engine']).toBe('claude');
    expect(bySlug['from-claude']!['source_host_id']).toBe(9);
  });
});
