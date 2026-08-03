/**
 * `npm run test:db:setup` — applies `src/db/baseline/schema.sql` to the test
 * database so `npm run migrate && npm run test:db` can run against an empty
 * MySQL. It is the same baseline and the same statement splitting that
 * `migrate.js --init-schema` uses to provision a fresh installation, resolved
 * through `loadBaseline()` so the two can never read different files.
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
 * and names it. (`--init-schema` checks information_schema first and skips
 * instead, because an installer has to be re-runnable; a test setup step does
 * not, and the louder failure is more useful here.)
 */

import mysql from 'mysql2/promise';
import { loadBaseline } from '../../src/db/migrator.js';
import { readDbConfig } from '../helpers/test-db.js';

async function main(): Promise<number> {
  const cfg = readDbConfig();
  if (!cfg) {
    process.stderr.write(
      'no test database configured: set TEST_USE_DB=1 with either TEST_DATABASE_URL or DB_DATABASE/DB_USERNAME\n',
    );
    return 1;
  }

  const statements = await loadBaseline();
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
