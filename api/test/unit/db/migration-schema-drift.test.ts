import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitSqlStatements } from '../../../src/db/migration-sql.js';
import { loadMigrations } from '../../../src/db/migrator.js';

/**
 * AGENTS.md requires a migration to land with the matching `schema.ts` update in
 * the same commit, and `src/db/baseline/schema.sql` is generated from
 * `schema.ts`, provisions the DB-backed suites, and provisions every fresh
 * installation through `migrate.js --init-schema`. Nothing enforced the pairing:
 * the double-apply test in `test/integration/db-migrations/` needs a real
 * database, so a migration shipped without the schema update would leave
 * production ahead of both the mirror and the baseline with every gate green.
 *
 * This is the static half of that check — table and column additions only, read
 * out of the shipped SQL and looked up in the baseline. Types, defaults, indexes
 * and constraints are not compared; the baseline cannot express FULLTEXT or
 * foreign keys anyway (see the header of the baseline).
 */

const BASELINE = resolve(import.meta.dirname, '../../../src/db/baseline/schema.sql');

/** Anchored: a `CREATE TABLE` quoted inside a CALL argument is not a creation. */
const CREATE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_$]+)`?/i;
/** Unanchored: 0005 hides its ALTERs inside `CALL add_auth_generation_column(…)`. */
const ADD_COLUMN = /ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?\s+ADD\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi;
/**
 * Anchored, like `CREATE TABLE`: a drop quoted inside a CALL argument is not one.
 * The name list is captured whole because 0001 drops five tables in one
 * comma-separated statement.
 */
const DROP_TABLE = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`A-Za-z0-9_$,\s]+)/i;
/**
 * Unanchored, and matches the `CONCAT('ALTER TABLE `', tbl, '` DROP COLUMN …')`
 * form too: 0009 has to build its DDL as a string because MySQL has no
 * `DROP COLUMN IF EXISTS`, so the table name arrives via `CALL`.
 */
const DROP_COLUMN = /DROP\s+COLUMN\s+`?([A-Za-z0-9_$]+)`?/gi;
const DROP_COLUMN_CALL = /CALL\s+drop_[A-Za-z0-9_$]*column\s*\(\s*'([A-Za-z0-9_$]+)'\s*,\s*'([A-Za-z0-9_$]+)'\s*\)/gi;

interface Addition {
  migration: string;
  table: string;
  column?: string;
}

/**
 * Statements come from the production splitter, so comments are already gone —
 * the prose in 0003/0006 that quotes `CREATE TABLE IF NOT EXISTS` cannot be
 * mistaken for a real one.
 */
const migrationAdditions = async (): Promise<Addition[]> => {
  const additions: Addition[] = [];
  for (const file of await loadMigrations()) {
    for (const statement of file.statements) {
      const created = CREATE_TABLE.exec(statement);
      if (created) {
        additions.push({ migration: file.filename, table: created[1]! });
      }
      for (const [, table, column] of statement.matchAll(ADD_COLUMN)) {
        additions.push({ migration: file.filename, table: table!, column: column! });
      }
    }
  }
  return additions;
};

/**
 * The mirror image: what later migrations take back out. Without this, every
 * migration that drops something a *previous* migration added reads as an
 * addition `schema.ts` forgot — 0008 creates `agent_matrix_outbox` and 0009
 * drops it, and the baseline is right to contain neither.
 */
const migrationRemovals = async (): Promise<Set<string>> => {
  const removed = new Set<string>();
  for (const file of await loadMigrations()) {
    for (const statement of file.statements) {
      const dropped = DROP_TABLE.exec(statement);
      if (dropped) {
        for (const name of dropped[1]!.split(',')) {
          const table = name.trim().replaceAll('`', '');
          if (table) removed.add(table);
        }
      }
      for (const [, table, column] of statement.matchAll(DROP_COLUMN_CALL)) {
        removed.add(`${table}.${column}`);
      }
      // A direct `ALTER TABLE t DROP COLUMN c`, where the table is in the same
      // statement rather than passed to a procedure.
      const direct = /ALTER\s+TABLE\s+`?([A-Za-z0-9_$]+)`?/i.exec(statement);
      if (direct) {
        for (const [, column] of statement.matchAll(DROP_COLUMN)) {
          removed.add(`${direct[1]!}.${column}`);
        }
      }
    }
  }
  return removed;
};

const baselineTables = (): Map<string, Set<string>> => {
  const tables = new Map<string, Set<string>>();
  for (const statement of splitSqlStatements(readFileSync(BASELINE, 'utf8'))) {
    const table = /^CREATE\s+TABLE\s+`([^`]+)`/i.exec(statement);
    if (!table) continue; // The trailing `CREATE INDEX` run.
    const columns = new Set<string>();
    for (const line of statement.split('\n')) {
      // A column definition is a backticked name followed by its type; the
      // `CONSTRAINT …` lines in the same body start with a bare keyword.
      const column = /^\s*`([^`]+)`\s+\S/.exec(line);
      if (column) columns.add(column[1]!);
    }
    tables.set(table[1]!, columns);
  }
  return tables;
};

describe('migrations against the test baseline', () => {
  it('adds no table or column that schema-baseline.sql lacks', async () => {
    const baseline = baselineTables();
    const retired = await migrationRemovals();
    const missing: string[] = [];

    for (const { migration, table, column } of await migrationAdditions()) {
      const columns = baseline.get(table);
      if (retired.has(table)) continue;
      if (column === undefined) {
        if (!columns) missing.push(`${migration}:${table}`);
        continue;
      }
      if (retired.has(`${table}.${column}`)) continue;
      if (!columns?.has(column)) missing.push(`${migration}:${table}.${column}`);
    }

    // Each entry is a schema change that reached `migrations/` without reaching
    // `schema.ts`: update the mirror and regenerate the fixture.
    expect(missing).toEqual([]);
  });

  // Pins the removal extraction the same way: a regex that stops matching here
  // would make the check above start reporting retired schema as drift.
  it('reads the tables and columns the shipped migrations actually remove', async () => {
    expect([...(await migrationRemovals())].sort()).toEqual([
      'agent_matrix_outbox',
      'agent_portal_users.matrix_room',
      'claude_usage_snapshots',
      'dashboard_graph_claude_daily_stats',
      'dashboard_graph_usage_daily_stats',
      'hosts.config_baked_at',
      'ip_rate_limits',
      'openai_api_keys.rate_limit_rpm',
      'token_usage_ingests',
      'token_usages',
    ]);
  });

  // Pins the extraction itself, so a regex that quietly stops matching cannot
  // turn the check above into a test of an empty list.
  it('reads the tables and columns the shipped migrations actually add', async () => {
    const additions = await migrationAdditions();

    expect(additions.filter((a) => a.column === undefined).map((a) => a.table)).toEqual([
      'coord_project_memories',
      'claude_artifacts',
      'auth_canonical_heads',
      'shared_memories',
      'shared_memory_chunks',
      'shared_memory_revisions',
      'skill_files',
      'agent_portal_users',
      'agent_portal_browser_sessions',
      'agent_sessions',
      'agent_events',
      'agent_prompts',
      'agent_messages',
      'agent_matrix_outbox',
      'secrets',
      'agent_bus_addresses',
      'agent_bus_conversations',
      'agent_bus_messages',
      'agent_bus_relays',
      'agent_policy_profiles',
      'agent_policy_profile_assignments',
      'agent_bus_conferences',
      'agent_bus_conference_members',
    ]);
    expect(
      additions.filter((a) => a.column !== undefined).map((a) => `${a.table}.${a.column}`),
    ).toEqual([
      'auth_payloads.generation',
      'auth_payloads.source_kind',
      'auth_payloads.parent_payload_id',
      'auth_payloads.credential_kind',
      'auth_payloads.fingerprint_kid',
      'auth_payloads.access_fingerprint',
      'auth_payloads.refresh_fingerprint',
      'auth_payloads.pair_fingerprint',
      'auth_payloads.credential_issued_at',
      'auth_payloads.access_expires_at',
      'auth_payloads.refresh_expires_at',
      'auth_payloads.superseded_at',
      'auth_payloads.purge_after',
      'skills.source_type',
      'skills.source_repository',
      'skills.source_path',
      'skills.source_revision',
      'skills.source_license',
      'skills.bundle_sha256',
      'shared_memory_revisions.prev_content',
      'secrets.source_host_id',
      'secrets.source_engine',
      'hosts.agent_messaging_enabled',
      'agent_bus_messages.dispatch_order',
      'agent_sessions.agent_bus_address_id',
      'agent_sessions.adapter_protocol',
      'agent_sessions.adapter_capabilities',
      'agent_sessions.receive_heartbeat_at',
      'agent_sessions.binding_generation',
      'agent_sessions.close_requested_at',
      'agents_documents.builder_state',
      'agent_bus_addresses.call_pin',
      'agent_bus_addresses.call_pin_expires_at',
    ]);
  });

  it('reads whole tables out of the baseline, columns and all', () => {
    const baseline = baselineTables();
    expect(baseline.get('auth_canonical_heads')).toEqual(
      new Set(['engine', 'payload_id', 'generation', 'updated_at']),
    );
    expect(baseline.get('schema_migrations')?.has('checksum')).toBe(true);
  });
});
