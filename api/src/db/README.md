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

By hand:

```sh
# In a checkout (DB_* come from ../.env):
cd api && npm run migrate            # apply
npm run migrate:check                # exit 1 if anything is pending

# Against a running stack:
docker compose exec -T api node migrate.js --list
docker compose run --rm -T api node migrate.js
```

Useful flags: `--check`, `--list`, `--dry-run`, `--json`, `--baseline VERSION`,
`--reapply VERSION`, `--lock-timeout SECS`. `--help` documents all of them.

## The ledger

`schema_migrations` (created by the runner, mirrored in `schema.ts`, never
written through Drizzle) holds one row per applied version with the file's
sha256, statement count, duration, and who applied it. A MySQL advisory lock
(`GET_LOCK`) serialises concurrent runners, so several API instances booting at
once is safe.

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
migrations are destructive. Apply it explicitly:

```sh
docker compose exec -T api node migrate.js --reapply 0003
```

### Adopting the runner on a database migrated by hand

`--baseline VERSION` writes ledger rows for everything up to `VERSION` without
executing it, so only the genuinely new files run:

```sh
docker compose run --rm -T api node migrate.js --baseline 0006
```

**Do this once per existing deployment, before the first boot of the commit that
introduced the runner.** Any database that was migrated by hand has no ledger, so
the runner sees every historical file as pending and replays it. That is safe —
every file is idempotent, and the tables 0001 drops are long gone — but replaying
a `DROP TABLE` and three FULLTEXT rebuilds against a populated production
database is not a good surprise. `crane` had 0001–0006 applied by hand as of
2026-07-27, so `--baseline 0006` is its correct starting point.

## The baseline

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

`--init-schema` takes the migration lock, checks `information_schema` for
application tables, and only when there are none applies the baseline and then
runs the full migration set on top. Against a database that already has tables it
reports `skipped` and migrates as usual, so `bin/install.sh` can re-run any of its
steps without special-casing the first one. It refuses to combine with
`--baseline`, which records without executing and would otherwise mark every
migration applied over a schema that was never created.

The same artifact and the same statement splitting provision the DB-backed suites
— `test/fixtures/apply-schema-baseline.ts` calls `loadBaseline()` rather than
resolving its own path, so the two can never read different files:

```sh
cd api
npm run test:db:setup   # apply the baseline to TEST_DATABASE_URL / DB_*
npm run migrate         # then evolve it like any other database
npm run test:db
```

`.github/workflows/api.yml` runs exactly that sequence in its `db` job against a
`services: mysql` container — so the baseline-then-migrate path a fresh install
depends on is exercised on every CI run, not only on install day.

The file is generated from `schema.ts`, not hand-written; regenerate it after a
schema change with the `drizzle-kit generate` command in its own header.
`schema-baseline-drift` and `migration-schema-drift` fail if you forget. Because
it is drizzle output it has the mirror's blind spots — no FULLTEXT indexes, no
foreign keys — so a database built from it is precisely the `drizzle-kit push`
shape that 0003 and 0006 carry their backstops for. That is a feature twice over:
the real-DB suites exercise those backstops rather than asserting against a schema
that was already correct, and a freshly installed database ends up in the same
shape as every database that predates the runner.

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
- Do not use `drizzle:push` against a real database. It reconciles the whole
  hand-maintained mirror instead of applying `migrations/`, and can express
  neither FULLTEXT indexes nor foreign keys — which is exactly why 0003 and 0006
  carry backstops that add both after the fact.
