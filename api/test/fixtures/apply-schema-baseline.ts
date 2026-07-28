/**
 * `npm run test:db:setup` — applies `schema-baseline.sql` to the test database
 * so `npm run migrate && npm run test:db` can run against an empty MySQL.
 *
 * The target is resolved by the suites' own `readDbConfig()`, so
 * `TEST_DATABASE_URL` and the `DB_*` fallback mean exactly what they mean to
 * `getTestDb()`. Statements go through the production splitter on a single
 * connection, same as the migration runner: `multipleStatements` stays off.
 *
 * This expects an empty database. The baseline is drizzle-kit output, which
 * emits plain `CREATE TABLE`/`CREATE INDEX` — MySQL has no
 * `CREATE INDEX IF NOT EXISTS`, so there is no honest way to make a re-run a
 * no-op. Against a database that already has tables it fails on the first one
 * and names it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { splitSqlStatements } from '../../src/db/migration-sql.js';
import { readDbConfig } from '../helpers/test-db.js';

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'schema-baseline.sql');

async function main(): Promise<number> {
  const cfg = readDbConfig();
  if (!cfg) {
    process.stderr.write(
      'no test database configured: set TEST_DATABASE_URL, or DB_DATABASE/DB_USERNAME with TEST_USE_DB=1\n',
    );
    return 1;
  }

  const statements = splitSqlStatements(readFileSync(BASELINE, 'utf8'));
  const conn = await mysql.createConnection({ ...cfg, multipleStatements: false });
  try {
    for (const statement of statements) {
      try {
        await conn.query(statement);
      } catch (err) {
        const head = statement.split('\n', 1)[0]!;
        throw new Error(`${head} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await conn.end();
  }

  process.stdout.write(`baseline applied to ${cfg.database}: ${statements.length} statement(s)\n`);
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
}
