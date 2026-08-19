import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { HostClaudeArtifactsService } from '../../../src/services/host-claude-artifacts.js';
import { RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS } from '../../../src/services/agent-response-style.js';
import { getTestDb, type TestDb } from '../../helpers/test-db.js';

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/db/migrations/0004_add_claude_artifacts.sql',
);

const handle = await getTestDb();

function sqlStatements(text: string): string[] {
  return text
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe.skipIf(!handle)('Claude artifacts migration against a real database', () => {
  let db: TestDb;

  const execute = async (query: string) => db.execute(sql.raw(query));
  const rowsOf = (result: unknown): Array<Record<string, unknown>> => {
    const first = Array.isArray(result) ? (result[0] as unknown) : result;
    return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : [];
  };
  const applyMigration = async () => {
    for (const statement of sqlStatements(readFileSync(MIGRATION, 'utf8'))) {
      await execute(statement);
    }
  };

  beforeAll(async () => {
    db = handle!.db;
    await applyMigration();
  });

  afterAll(async () => {
    await handle?.pool.end();
  });

  it('is idempotent and creates the complete table contract', async () => {
    await applyMigration();

    const columns = rowsOf(
      await execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'claude_artifacts'
          ORDER BY ORDINAL_POSITION`,
      ),
    ).map((row) => row['COLUMN_NAME']);
    expect(columns).toEqual([
      'id',
      'kind',
      'slug',
      'sha256',
      'display_name',
      'description',
      'model',
      'frontmatter',
      'body',
      'source_host_id',
      'created_at',
      'updated_at',
      'deleted_at',
      'engine',
    ]);

    const indexes = rowsOf(
      await execute(
        `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'claude_artifacts'
          ORDER BY INDEX_NAME`,
      ),
    ).map((row) => row['INDEX_NAME']);
    expect(indexes).toEqual([
      'idx_claude_artifacts_engine',
      'idx_claude_artifacts_kind',
      'idx_claude_artifacts_updated_at',
      'PRIMARY',
      'uq_claude_artifacts_kind_slug',
    ]);
  });

  // The bootstrap bundle used to be empty on a fresh database. Migration 0023
  // seeds one output-style document per non-zero response-verbosity level, and
  // `client-config.ts` points Claude Code's `outputStyle` at one of those slugs
  // -- so the wrapper has to receive the documents before it can select one.
  // Asserted on slugs, not bodies: the seeded text is data owned by the
  // migration, not by this test.
  it('bundles the seeded response-verbosity output styles for a bootstrapping host', async () => {
    const bundle = await new HostClaudeArtifactsService(db).bundle(
      { id: 0 } as never,
      'claude',
      {},
    );

    expect(bundle.subagent).toEqual([]);
    expect(bundle.command).toEqual([]);

    const seeded = Object.values(RESPONSE_VERBOSITY_OUTPUT_STYLE_SLUGS)
      .filter((slug): slug is string => typeof slug === 'string')
      .sort();
    expect(bundle['output-style'].map((entry) => entry.slug)).toEqual(seeded);
    for (const entry of bundle['output-style']) {
      // A host with no digests knows none of them yet, so every one carries content.
      expect(entry.status).toBe('updated');
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(createHash('sha256').update(entry.content ?? '').digest('hex')).toBe(entry.sha256);
    }
  });
});
