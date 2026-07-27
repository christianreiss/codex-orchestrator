import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { SharedMemoriesService } from '../../../src/services/shared-memories.js';
import { chunkContent } from '../../../src/services/shared-memory-chunker.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';
import type { Host } from '../../../src/db/schema.js';

/**
 * The only tests that exercise shared memories against real MySQL.
 *
 * The unit suite runs on `db-fake`, which has no unique index, no FULLTEXT, no
 * ORDER BY and no `execute` — so slug uniqueness, MATCH ranking, chunk-join
 * correctness and FK cascade have zero coverage there by construction. CI runs
 * without a database, so this file skips there. Run it with:
 *
 *   npm run test:db          (TEST_USE_DB=1 + DB_* env)
 *   TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/db npx vitest run test/integration
 *
 * The suite applies `0006_add_shared_memories.sql` itself (the file is
 * idempotent), which both makes it self-sufficient and covers the migration —
 * including its backstop for tables created by `drizzle-kit push`, which cannot
 * express FULLTEXT.
 *
 * Fixture vocabulary note: InnoDB's default `innodb_ft_min_token_size` is 3 and
 * the stopword list is on, so every searched term here is >= 3 characters and
 * not a stopword. A 2-character or stopword-only query returns zero rows with
 * no error, which is indistinguishable from "no matches".
 */

/** Split a migration into statements; mysql2 rejects multi-statement by default. */
function sqlStatements(text: string): string[] {
  return text
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../../src/db/migrations/0006_add_shared_memories.sql');

const FQDN_A = 'ztest-shared-a.example';
const FQDN_B = 'ztest-shared-b.example';

const handle = await getTestDb();

describe.skipIf(!handle)('shared memories against a real database', () => {
  let db: TestDb;
  let svc: SharedMemoriesService;
  let hostA: Host;
  let hostB: Host;

  const exec = async (q: string) => db.execute(sql.raw(q));
  const rowsOf = (res: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(res) ? (res[0] as unknown) : res;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const cleanup = async () => {
    await exec(`DELETE FROM shared_memories WHERE slug LIKE 'ztest-%'`);
    await exec(`DELETE FROM hosts WHERE fqdn IN ('${FQDN_A}', '${FQDN_B}')`);
  };

  beforeAll(async () => {
    db = handle!.db;
    for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
    await cleanup();

    const now = new Date().toISOString();
    for (const fqdn of [FQDN_A, FQDN_B]) {
      await exec(
        `INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at)
         VALUES ('${fqdn}', SHA2('${fqdn}', 256), 'active', '${now}', '${now}')`,
      );
    }
    const hostRows = rowsOf(await exec(`SELECT id, fqdn FROM hosts WHERE fqdn IN ('${FQDN_A}', '${FQDN_B}') ORDER BY fqdn`));
    hostA = hostRows.find((r) => r['fqdn'] === FQDN_A) as unknown as Host;
    hostB = hostRows.find((r) => r['fqdn'] === FQDN_B) as unknown as Host;

    svc = new SharedMemoriesService(db);
  });

  afterAll(async () => {
    await cleanup();
    await handle?.pool.end();
  });

  describe('migration', () => {
    it('creates both FULLTEXT indexes', async () => {
      const rows = rowsOf(
        await exec(
          `SELECT TABLE_NAME, INDEX_NAME, INDEX_TYPE, COLUMN_NAME
             FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND INDEX_NAME IN ('idx_shared_memories_search', 'idx_shared_memory_chunks_search')`,
        ),
      );
      expect(rows.length).toBeGreaterThanOrEqual(6); // 3 columns per index
      expect(rows.every((r) => r['INDEX_TYPE'] === 'FULLTEXT')).toBe(true);
    });

    it('is idempotent — re-running changes nothing', async () => {
      const before = rowsOf(
        await exec(
          `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'shared_memor%'`,
        ),
      );
      for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);
      const after = rowsOf(
        await exec(
          `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'shared_memor%'`,
        ),
      );
      expect(Number(after[0]!['c'])).toBe(Number(before[0]!['c']));
    });

    it('backfills a FULLTEXT index dropped from an existing table', async () => {
      await exec('ALTER TABLE shared_memory_chunks DROP INDEX idx_shared_memory_chunks_search');
      try {
        const missing = rowsOf(
          await exec(
            `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'idx_shared_memory_chunks_search'`,
          ),
        );
        expect(Number(missing[0]!['c'])).toBe(0);

        for (const stmt of sqlStatements(readFileSync(MIGRATION, 'utf8'))) await exec(stmt);

        const restored = rowsOf(
          await exec(
            `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'idx_shared_memory_chunks_search'`,
          ),
        );
        expect(Number(restored[0]!['c'])).toBeGreaterThan(0);
      } finally {
        // Restore even if an assertion above failed, so the rest of the suite
        // does not run against a half-indexed table.
        const still = rowsOf(
          await exec(
            `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'idx_shared_memory_chunks_search'`,
          ),
        );
        if (Number(still[0]!['c']) === 0) {
          await exec('ALTER TABLE shared_memory_chunks ADD FULLTEXT INDEX idx_shared_memory_chunks_search (content, heading, tags_text)');
        }
      }
    });
  });

  describe('storage', () => {
    it('enforces one row per slug across hosts', async () => {
      await svc.write({ slug: 'ztest-unique', content: 'written by alpha' }, hostA);
      await svc.write({ slug: 'ztest-unique', content: 'written by beta' }, hostB);

      const rows = rowsOf(await exec(`SELECT id, content, revision, source_host_id FROM shared_memories WHERE slug = 'ztest-unique'`));
      expect(rows).toHaveLength(1);
      expect(rows[0]!['content']).toBe('written by beta');
      expect(Number(rows[0]!['revision'])).toBe(2);
      expect(Number(rows[0]!['source_host_id'])).toBe(Number((hostB as unknown as { id: number }).id));
    });

    it('treats slugs case-insensitively the same way the unique index does', async () => {
      await svc.write({ slug: 'ztest-Case', content: 'first' }, hostA);
      await svc.write({ slug: 'ZTEST-case', content: 'second' }, hostA);
      const rows = rowsOf(await exec(`SELECT slug, content FROM shared_memories WHERE slug LIKE 'ztest-case'`));
      expect(rows).toHaveLength(1);
      expect(rows[0]!['slug']).toBe('ztest-case');
      expect(rows[0]!['content']).toBe('second');
    });

    it('stores one chunk row per chunk and tiles the document exactly', async () => {
      // `write` trims the body, so compare against the trimmed form — that is
      // what was stored and what the chunks must reproduce.
      const body = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n${'sentence about the fleet. '.repeat(40)}`)
        .join('\n\n')
        .trim();
      await svc.write({ slug: 'ztest-chunks', content: body, tags: ['ops'] }, hostA);

      const doc = rowsOf(await exec(`SELECT id, chunk_count, content_length, revision FROM shared_memories WHERE slug = 'ztest-chunks'`))[0]!;
      const chunks = rowsOf(
        await exec(`SELECT ordinal, heading, content, char_start, char_end, revision, tags_text
                      FROM shared_memory_chunks WHERE memory_id = ${Number(doc['id'])} ORDER BY ordinal`),
      );

      expect(chunks).toHaveLength(Number(doc['chunk_count']));
      expect(chunks.length).toBe(chunkContent(body).length);
      expect(Number(chunks[0]!['char_start'])).toBe(0);
      expect(Number(chunks[chunks.length - 1]!['char_end'])).toBe(Number(doc['content_length']));
      expect(chunks.map((c) => String(c['content'])).join('')).toBe(body);
      expect(chunks.every((c) => Number(c['revision']) === Number(doc['revision']))).toBe(true);
      expect(chunks[0]!['tags_text']).toBe('ops');
    });

    it('replaces the chunk set on rewrite, leaving no stale revisions', async () => {
      await svc.write({ slug: 'ztest-rewrite', content: 'alpha '.repeat(1200) }, hostA);
      const id = Number(rowsOf(await exec(`SELECT id FROM shared_memories WHERE slug = 'ztest-rewrite'`))[0]!['id']);
      const first = rowsOf(await exec(`SELECT DISTINCT revision FROM shared_memory_chunks WHERE memory_id = ${id}`));
      expect(first).toHaveLength(1);

      await svc.write({ slug: 'ztest-rewrite', content: 'beta' }, hostB);
      const after = rowsOf(await exec(`SELECT revision, COUNT(*) AS c FROM shared_memory_chunks WHERE memory_id = ${id} GROUP BY revision`));
      expect(after).toHaveLength(1);
      expect(Number(after[0]!['revision'])).toBe(2);
      expect(Number(after[0]!['c'])).toBe(1);
    });

    // The FK cascade only exists because 0006 backfills it: `drizzle-kit push`
    // builds these tables from schema.ts, which cannot express a foreign key.
    it('cascades chunk and revision rows on hard delete', async () => {
      await svc.write({ slug: 'ztest-cascade', content: 'body text here' }, hostA);
      const id = Number(rowsOf(await exec(`SELECT id FROM shared_memories WHERE slug = 'ztest-cascade'`))[0]!['id']);
      await exec(`DELETE FROM shared_memories WHERE id = ${id}`);

      expect(rowsOf(await exec(`SELECT id FROM shared_memory_chunks WHERE memory_id = ${id}`))).toHaveLength(0);
      expect(rowsOf(await exec(`SELECT id FROM shared_memory_revisions WHERE memory_id = ${id}`))).toHaveLength(0);
    });

    // Regression: a soft delete advances the revision ledger, so it must advance
    // the row's own counter too. When it did not, the revive below recomputed a
    // revision the ledger already held and the write died on
    // uniq_shared_memory_revision. db-fake enforces no unique keys, so only a
    // real database can catch this.
    it('survives write -> soft delete -> write on the same slug', async () => {
      await svc.write({ slug: 'ztest-revive', content: 'first body' }, hostA);
      await svc.delete({ slug: 'ztest-revive' }, hostA);
      const revived = (await svc.write({ slug: 'ztest-revive', content: 'second body' }, hostB)) as Record<string, unknown>;

      expect(revived['status']).toBe('created');
      const rows = rowsOf(await exec(`SELECT id, content, revision, deleted_at FROM shared_memories WHERE slug = 'ztest-revive'`));
      expect(rows).toHaveLength(1);
      expect(rows[0]!['content']).toBe('second body');
      expect(rows[0]!['deleted_at']).toBeNull();

      const ledger = rowsOf(await exec(`SELECT revision, op FROM shared_memory_revisions WHERE memory_id = ${Number(rows[0]!['id'])} ORDER BY revision`));
      expect(ledger.map((r) => r['op'])).toEqual(['create', 'delete', 'create']);
      expect(ledger.map((r) => Number(r['revision']))).toEqual([1, 2, 3]);

      // And the revived document is searchable again, with only its new chunks.
      const chunks = rowsOf(await exec(`SELECT DISTINCT revision FROM shared_memory_chunks WHERE memory_id = ${Number(rows[0]!['id'])}`));
      expect(chunks.map((c) => Number(c['revision']))).toEqual([3]);
    });

    // Listings must not select the 1 MiB body — they select LEFT(content, n)
    // instead. db-fake ignores projections and returns whole rows, so a
    // projection mistake is invisible to the unit suite: only a real query can
    // show an empty preview for a document that has no summary.
    it('previews a summary-less document without selecting its body', async () => {
      const body = ('PREVIEWMARKER opening sentence. ' + 'filler text. '.repeat(20_000)).trim();
      await svc.write({ slug: 'ztest-preview', content: body }, hostA);

      const out = (await svc.list({ prefix: 'ztest-preview', limit: 5 }, hostA)) as { memories: Array<Record<string, unknown>> };
      const found = out.memories.find((m) => m['slug'] === 'ztest-preview')!;
      expect(String(found['preview'])).toContain('PREVIEWMARKER');
      expect(found).not.toHaveProperty('content');
      expect(found['content_length']).toBe(body.length);

      // resources/list uses the same projection.
      const recent = await svc.listRecent(200);
      const viaResource = recent.find((m) => m.slug === 'ztest-preview')!;
      expect(viaResource.preview).toContain('PREVIEWMARKER');
    });

    it('returns bodies only for the requested page when include_content is set', async () => {
      await svc.write({ slug: 'ztest-inline', content: 'inline body text' }, hostA);
      const out = (await svc.list({ prefix: 'ztest-inline', limit: 5, include_content: true }, hostA)) as {
        limit: number;
        memories: Array<Record<string, unknown>>;
      };
      expect(out.memories[0]!['content']).toBe('inline body text');
      // include_content clamps the page size hard.
      const clamped = (await svc.list({ prefix: 'ztest-', limit: 200, include_content: true }, hostA)) as { limit: number };
      expect(clamped.limit).toBe(20);
    });

    // `append` promises multi-writer safety in its tool description, the skill
    // text and the docs. Read-modify-write without a lock quietly breaks that:
    // both writers read the same base, both merge, and the second UPDATE wins
    // with no error and one writer's text simply gone.
    it('keeps both writers’ text when two appends race', async () => {
      await svc.write({ slug: 'ztest-race', content: 'base body' }, hostA);
      const results = await Promise.allSettled([
        svc.append({ slug: 'ztest-race', content: 'alpha addition' }, hostA),
        svc.append({ slug: 'ztest-race', content: 'beta addition' }, hostB),
      ]);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

      const body = String(rowsOf(await exec(`SELECT content FROM shared_memories WHERE slug = 'ztest-race'`))[0]!['content']);
      expect(body).toContain('alpha addition');
      expect(body).toContain('beta addition');
    });

    // Simulates a write that died after inserting chunks but before flipping the
    // parent to that revision. Reusing the revision number collided on
    // uniq_shared_memory_chunk, and since the leftover rows never go away that
    // made EVERY later write to the slug fail — permanently.
    it('recovers a slug wedged by orphan chunks at an unadopted revision', async () => {
      await svc.write({ slug: 'ztest-wedge', content: 'body one' }, hostA);
      const id = Number(rowsOf(await exec(`SELECT id FROM shared_memories WHERE slug = 'ztest-wedge'`))[0]!['id']);
      await exec(
        `INSERT INTO shared_memory_chunks (memory_id, revision, ordinal, heading, content, char_start, char_end, tags_text, created_at)
         VALUES (${id}, 2, 0, NULL, 'orphan', 0, 6, NULL, '2026-07-27T00:00:00Z')`,
      );

      const out = (await svc.write({ slug: 'ztest-wedge', content: 'body two' }, hostA)) as Record<string, unknown>;
      expect(out['status']).toBe('updated');
      const revisions = rowsOf(await exec(`SELECT DISTINCT revision FROM shared_memory_chunks WHERE memory_id = ${id}`));
      expect(revisions.map((r) => Number(r['revision']))).toEqual([3]);
    });

    // A heading-dense document is legal (under 1 MiB) but produces far more than
    // the structural chunk budget. The chunker used to hand the whole remainder
    // back as one final chunk, which overflowed chunks.content TEXT(65535) and
    // failed the write outright.
    it('stores a heading-dense document that overruns the structural chunk budget', async () => {
      const body = Array.from({ length: 2016 }, () => '## S\n' + 'y'.repeat(515))
        .join('\n')
        .slice(0, 1_048_576)
        .trim();
      const out = (await svc.write({ slug: 'ztest-dense', content: body }, hostA)) as Record<string, unknown>;
      expect(out['status']).toBe('created');

      const chunks = rowsOf(await exec(`SELECT MAX(CHAR_LENGTH(content)) AS m, COUNT(*) AS c FROM shared_memory_chunks
                                          WHERE memory_id = (SELECT id FROM shared_memories WHERE slug = 'ztest-dense')`));
      expect(Number(chunks[0]!['m'])).toBeLessThanOrEqual(4000);
      expect(Number(chunks[0]!['c'])).toBeGreaterThan(1000);
    });

    it('stores a 1 MiB document and reads a window out of it', async () => {
      const body = 'lorem ipsum dolor sit amet consectetur. '.repeat(27_000).slice(0, 1_048_576);
      expect(body).toHaveLength(1_048_576);
      await svc.write({ slug: 'ztest-big', content: body }, hostA);

      const out = (await svc.read({ slug: 'ztest-big', offset: 500_000, max_chars: 1000 }, hostA)) as Record<string, unknown>;
      expect(out['content']).toBe(body.slice(500_000, 501_000));
      expect(out['truncated']).toBe(true);
      expect((out['memory'] as Record<string, unknown>)['content_length']).toBe(1_048_576);
    });
  });

  describe('search', () => {
    beforeAll(async () => {
      await svc.write(
        {
          slug: 'ztest-search-crane',
          title: 'Crane deployment',
          content: '# Crane\n\nDeployment to crane uses explicit paths.\n\n## Rollback\n\nRollback restores the previous image tag.',
          tags: ['deployment', 'crane'],
        },
        hostA,
      );
      await svc.write(
        {
          slug: 'ztest-search-auth',
          title: 'Auth bootstrap',
          content: '# Bootstrap\n\nCanonical authentication payload validation happens before storage.',
          tags: ['authentication'],
        },
        hostB,
      );
    });

    it('ranks chunk hits by MATCH score and points at the matching passage', async () => {
      const out = (await svc.search({ query: 'rollback', limit: 5 }, hostA)) as {
        degraded: boolean;
        matches: Array<Record<string, unknown>>;
      };

      expect(out.degraded).toBe(false);
      expect(out.matches.length).toBeGreaterThan(0);
      const top = out.matches[0]!;
      expect(top['slug']).toBe('ztest-search-crane');
      expect(Number(top['score'])).toBeGreaterThan(0);
      expect(String(top['excerpt']).toLowerCase()).toContain('rollback');
      expect(String(top['uri'])).toMatch(/^shared:\/\/ztest-search-crane#\d+$/);
    });

    it('finds a document written by another host — nothing is host-scoped', async () => {
      const out = (await svc.search({ query: 'authentication', limit: 5 }, hostA)) as { matches: Array<Record<string, unknown>> };
      expect(out.matches.map((m) => m['slug'])).toContain('ztest-search-auth');
    });

    it('AND-filters by tag', async () => {
      const out = (await svc.search({ query: 'deployment', tags: ['crane'], limit: 5 }, hostA)) as {
        matches: Array<Record<string, unknown>>;
      };
      expect(out.matches.every((m) => m['slug'] === 'ztest-search-crane')).toBe(true);
    });

    it('folds hits into documents in documents mode', async () => {
      const out = (await svc.search({ query: 'crane rollback deployment', mode: 'documents', limit: 5 }, hostA)) as {
        matches: Array<Record<string, unknown>>;
      };
      const slugs = out.matches.map((m) => m['slug']);
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(slugs).toContain('ztest-search-crane');
    });

    it('never returns a soft-deleted document', async () => {
      await svc.write({ slug: 'ztest-search-gone', content: 'transient vocabulary marker zqxjv', title: 'gone' }, hostA);
      const before = (await svc.search({ query: 'zqxjv', limit: 5 }, hostA)) as { matches: unknown[] };
      expect(before.matches.length).toBeGreaterThan(0);

      await svc.delete({ slug: 'ztest-search-gone' }, hostA);
      const after = (await svc.search({ query: 'zqxjv', limit: 5 }, hostA)) as { matches: unknown[] };
      expect(after.matches).toHaveLength(0);
    });

    it('degrades instead of failing when the chunk FULLTEXT index is missing', async () => {
      await exec('ALTER TABLE shared_memory_chunks DROP INDEX idx_shared_memory_chunks_search');
      try {
        const out = (await svc.search({ query: 'rollback', limit: 5 }, hostA)) as {
          degraded: boolean;
          matches: Array<Record<string, unknown>>;
        };
        expect(out.degraded).toBe(true);
        expect(out.matches.map((m) => m['slug'])).toContain('ztest-search-crane');
      } finally {
        await exec('ALTER TABLE shared_memory_chunks ADD FULLTEXT INDEX idx_shared_memory_chunks_search (content, heading, tags_text)');
      }
    });
  });

  describe('listing', () => {
    it('lists the corpus with no query and reports a total', async () => {
      const out = (await svc.list({ prefix: 'ztest-', limit: 100 }, hostA)) as {
        count: number;
        total: number;
        memories: Array<Record<string, unknown>>;
      };
      expect(out.count).toBeGreaterThan(0);
      expect(out.total).toBeGreaterThanOrEqual(out.count);
      expect(out.memories.every((m) => String(m['slug']).startsWith('ztest-'))).toBe(true);
    });

    it('orders by recency', async () => {
      await svc.write({ slug: 'ztest-order-old', content: 'older document' }, hostA);
      await new Promise((r) => setTimeout(r, 1100)); // updated_at has second precision
      await svc.write({ slug: 'ztest-order-new', content: 'newer document' }, hostA);

      const out = (await svc.list({ prefix: 'ztest-order-', limit: 10 }, hostA)) as { memories: Array<Record<string, unknown>> };
      expect(out.memories.map((m) => m['slug'])).toEqual(['ztest-order-new', 'ztest-order-old']);
    });
  });
});
