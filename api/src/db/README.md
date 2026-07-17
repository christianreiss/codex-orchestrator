# Drizzle schema

`schema.ts` is the typed mirror used by Drizzle. Reviewable schema changes live
as hand-written SQL in `migrations/` and are applied explicitly before the API
is started.

## Applying a migration

```sh
docker compose exec -T mysql sh -lc \
  'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
  < api/src/db/migrations/0004_add_claude_artifacts.sql
```

There is no automatic migration runner or migration ledger. Apply each new SQL
file once as part of its deployment; migrations intended for retry must be
idempotent. API boot and `scripts/deploy.sh` probe required schema and fail when
`claude_artifacts` has not been created.

Do not use `drizzle:push` against an existing database. It reconciles the whole
hand-maintained mirror rather than applying `migrations/`, and cannot preserve
the FULLTEXT indexes defined by SQL migrations.
