-- Remove usage-based scaling (operator decision 2026-11-20), step 1 of 2.
--
-- The feature only ever stored and displayed its tiers: nothing applied a tier
-- and nothing read the per-host "always allowed" flag. The stored tier rules
-- were one `versions` key (there is no `usage_scaling_rules` table); this
-- deletes it.
--
-- STEP 2 IS DELIBERATELY NOT HERE: the `hosts.scaling_exempt` column stays in
-- the database and in the baseline schema for now. This build no longer maps
-- it in `schema.ts`, so nothing selects it any more. Drizzle emits explicit
-- column lists, so dropping the column in the same deploy would break an
-- outgoing or restarted old container on every host lookup (same two-step
-- procedure as 0017). Once every instance runs this build, a later migration
-- drops the column with an information_schema-guarded
-- `ALTER TABLE hosts DROP COLUMN scaling_exempt`.
--
-- Idempotent: the DELETE is a no-op without the key.

DELETE FROM `versions` WHERE `name` = 'usage_scaling_rules';
