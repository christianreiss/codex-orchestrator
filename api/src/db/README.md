# Schema, migrations, and the runner

`schema.ts` is the typed Drizzle mirror of the live database. Reviewable schema
changes live as hand-written SQL in `migrations/` and are applied by the
migration runner in `migrator.ts`.

## Applying migrations

Automatic, in two places:

- **API boot** — `RUN_MIGRATIONS_ON_BOOT` (default **on**) applies every pending
  file before the listener opens. With it off, boot still *fails* when something
  is pending; it never serves against a schema the code does not expect.
- **`scripts/deploy.sh`** — runs the CLI between `compose build` and `compose up`
  so a slow `ALTER` cannot eat the container healthcheck window, then re-checks
  with `--check` once the stack is up.

Read migration status while the API is running:

```sh
docker compose exec -T api node migrate.js --list
docker compose exec -T api node migrate.js --check    # exit 1 for pending migrations
```

Use the [deployment cutover](../../../docs/owner-cutover.md) to apply production migrations.
The mutating CLI acquires exclusive ownership of the database. For a local
checkout, stop the test API owner and export the `DB_*` variables for your
isolated database in the same shell:

```sh
cd api
npm run migrate
```

Useful flags: `--check`, `--list`, `--dry-run`, `--json`, `--baseline VERSION`,
`--reapply VERSION`, `--lock-timeout SECS`. `--help` documents all of them.

## The ledger

`schema_migrations` (created by the runner, mirrored in `schema.ts`, never
written through Drizzle) holds one row per applied version with the file's
sha256, statement count, duration, and who applied it. A MySQL advisory lock
(`GET_LOCK`) serialises migration runners. A separate owner lock admits one
serving API instance. Lock names are server-global, so the runner scopes its name to
the database (`codex_orchestrator_schema_migrations.<sha256(DATABASE())[:16]>`):
boot and the deploy CLI against the same database still serialise, while test
or staging databases on the same MySQL server no longer block each other.

Migrations run on a **single connection** and **without a transaction**. Both are
deliberate: the files use session state (`SET @… :=`, `PREPARE`/`EXECUTE`), and
MySQL DDL commits implicitly, so a transaction wrapper would be false safety. A
migration that fails part-way stays part-way applied and gets no ledger row —
which is why the next property matters.

## Writing a migration

1. Name it `NNNN_snake_case.sql`, next number in sequence. The runner rejects
   anything else, and rejects two files claiming the same number.
2. **Make it idempotent.** It must survive being applied to a database that
   already has the change: `CREATE TABLE IF NOT EXISTS`, `DROP … IF EXISTS`, and
   an `information_schema` guard behind `PREPARE`/`EXECUTE` for anything MySQL
   has no `IF NOT EXISTS` for (index, constraint, column). 0002, 0003, and 0006
   show the pattern. `test/integration/db-migrations/migrator.test.ts` enforces
   this by re-applying every shipped file against an already-migrated schema
   (`npm run test:db`, which runs the real-DB suites serially — they share one
   database and this one applies DDL to all of it).
3. Update `schema.ts` in the same commit.
4. `DELIMITER` works (0005 needs it for a stored procedure). It is handled by the
   splitter in `migration-sql.ts` and never sent to the server.

### Editing a migration that already shipped

Don't, if `NNNN+1` will do. The ledger stores a checksum, so an edited file shows
up as `drifted` in `--list` and warns on every boot — the edit is **not** applied
automatically, because a checksum flips on a comment change too and some
migrations are destructive. A reviewed reapplication requires the API owner
to be stopped and MySQL to remain available throughout the operation:

```sh
docker compose run --rm --no-deps -T api node migrate.js --reapply 0003
```

### Adopting the runner on a database migrated by hand

`--baseline VERSION` writes ledger rows for everything up to `VERSION` without
executing them. Verify which historical migrations were applied before choosing
the version. With MySQL available and the API owner stopped, for example:

```sh
docker compose run --rm --no-deps -T api node migrate.js --baseline 0006
```

This adoption step applies to a pre-ledger installation whose previous
migration history is known. Starting with a version that was never applied
would skip its SQL. Fresh installations use `--init-schema`; installations with
an existing ledger continue from their recorded versions.

## The baseline

Fresh installations seed Codex and Claude native CLI targets with `latest`. Grok and Kimi select their native release channels through the version resolver. Existing tenants keep their recorded host and fleet policies during numbered migrations. The baseline generator includes the seed SQL from `baseline/fresh-defaults.sql`.

`baseline/schema.sql` is how an empty MySQL becomes something the runner can
migrate. It is **not a migration**: it carries no ledger version, it is never
listed by `--list`, and it must never be moved into `migrations/`. Keeping it out
of the sequence is what stops every existing deployment seeing a new pending
migration the day it landed.

It *is* applied to deployments. That is a deliberate reversal of what this file
used to say — the previous rule ("production gets its schema from `migrations/`
and nowhere else") described an install path that did not exist, because the
migrations extend a schema rather than create one. A fresh installation now
provisions itself:

```sh
docker compose run --rm -T api node migrate.js --init-schema
```

`--init-schema` holds the database migration lock. Before its first application
DDL it records `@init-schema` in the existing `schema_migrations` ledger.
The row stores the SHA-256 of the executable baseline statements, the number
confirmed and a digest of the application table definitions. It disappears on
successful initialization. Normal API migration stops while this marker exists.

Rerun the original install command against the same database to resume.
The runner compares the current definitions with the checkpoint. For a lost
DDL acknowledgement it verifies the candidate table against a temporary
definition, or verifies the added index or foreign-key clause against the
preceding schema fingerprint. Seed DML commits with its checkpoint in one
transaction. Session-variable and prepared-statement sequences share a retry
boundary. After an interrupted collation alignment, the runner verifies the
two affected tables against empty temporary definitions generated from the
shipped baseline, both before and after conversion to the bus table collation.
It also checks the complete pre-operation fingerprint. Any extra column or
unrelated schema change prevents replay. If the result of another sequence
cannot be established, the schema differs
or the artifact changed, initialization stops before numbered migrations.
Inspect the recorded offset and affected table with `SHOW CREATE TABLE`.
Continue using the original artifact once the exact checkpoint or recognized
next DDL can be established. The runner preserves unresolved markers.

An existing numbered ledger retains its ordinary upgrade path. An unmarked
database with all declared baseline tables can migrate directly. An unmarked
partial schema requires inspection. For a deliberately older pre-ledger
installation, establish the previously applied versions and use the documented
migration/adoption command. `--baseline` and `--init-schema` are mutually
exclusive.

The same artifact and the same statement splitting provision the DB-backed suites
— `test/fixtures/apply-schema-baseline.ts` calls `loadBaseline()` rather than
resolving its own path, so the two can never read different files:

```sh
cd api
# Export DB_* for a disposable MySQL database. If TEST_DATABASE_URL is set,
# point it at that same database. The migration CLI reads DB_*.
npm run test:db:setup
npm run migrate         # then evolve it like any other database
npm run test:db
```

`.github/workflows/api.yml` runs exactly that sequence in its `db` job against a
`services: mysql` container — so the baseline-then-migrate path a fresh install
depends on is exercised on every CI run, not only on install day.

Run these destructive suites only against a disposable MySQL instance. The
server-owner composition fixture resolves both `TEST_DATABASE_URL` and `DB_*`
through `readDbConfig()` and creates/drops an isolated `owner_server_*` database;
its test account needs those DDL privileges. CI uses the disposable service's
root account for the DB tier, never production credentials or grants.

The file is generated from `schema.ts`, not hand-written. After a schema change,
run from `api/`:

```sh
npx tsx scripts/generate-schema-baseline.ts
# To inspect or test a candidate without replacing the shipped baseline:
npx tsx scripts/generate-schema-baseline.ts /tmp/candidate-baseline.sql
```

The generator uses a fresh temporary directory for Drizzle, strips its statement
separators, and shortens generated constraint/index names over MySQL's 64-character
limit to a 47-character prefix plus a stable 16-hex-digit SHA-256 suffix. Existing
short names and table/column references remain intact. It atomically replaces the
output only after generation succeeds. `schema-baseline-drift` and
`migration-schema-drift` check the schema pairing; test candidate SQL against an
empty disposable MySQL before shipping it.

The mirror includes some foreign keys; others and FULLTEXT indexes still come
from migrations, including the 0003 and 0006 backstops. Baseline regeneration is
not a migration and does not rename constraints on an existing deployment.

`scripts/build.ts` copies it to `dist/baseline/schema.sql`, resolved by
`defaultBaselineFile()` the same way `migrations/` is — `src/db/baseline` under
`tsx`, `dist/baseline` in the image. The build throws if it is missing.

## Limits

- There is no `0000_baseline.sql` and there should not be. 0003 and 0006 carry
  foreign keys to `coord_projects`/`hosts`, so the runner evolves an existing
  schema; it cannot build one from an empty database. `baseline/schema.sql`
  supplies that starting point, outside the migration sequence.
- `--init-schema` provisions; it never repairs. A database that is populated but
  wrong is an operator problem, not something the installer will overwrite.
- Do not use `drizzle-kit push` against a real database. It reconciles the mirror
  without the migration ledger or the historical FULLTEXT and foreign-key
  backstops in migrations 0003 and 0006.
