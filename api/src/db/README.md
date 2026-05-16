# Drizzle schema

`schema.ts` mirrors the cumulative state of the legacy PHP migrations
(`../../../src/Migrations/*.php`) exactly. The existing production database is
the source of truth; this file is a typed shadow that lets us read/write rows
through Drizzle.

## Generating the initial no-op migration

```sh
# Make sure your .env points DB_* at the live (already-migrated) database.
pnpm drizzle:generate
```

Drizzle Kit diffs `schema.ts` against the introspected live schema. If the two
match, the generated migration is empty — exactly what we want at cutover.

## Going forward

All future schema evolution lives in this file. Generate + apply with:

```sh
pnpm drizzle:generate   # writes a new migration to src/db/migrations/
pnpm drizzle:push       # applies pending migrations (dev/CI)
```

The 17 legacy PHP migration files are dead code after the cutover and live in
git history.
