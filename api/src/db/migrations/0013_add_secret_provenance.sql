-- Ownership for the fleet secrets store, so clients can run the full lifecycle
-- on their own credentials instead of only reading operator-provisioned ones.
--
-- `source_host_id` is what "own" means: a host that creates a secret over MCP
-- stamps itself here, and only that host may later rotate or delete it through
-- `secret_store` / `secret_delete`. A NULL owner marks a secret an operator
-- created through the admin API — those stay read-only to every host, which is
-- what keeps a shared infrastructure credential from being silently overwritten
-- by whichever agent happens to guess its slug. Admin CRUD is unaffected and can
-- still touch any row.
--
-- `source_engine` is provenance only, never a read filter — the same split
-- `shared_memories` already makes. Engine *visibility* remains the `engine`
-- column added in 0010.
--
-- Idempotent: `secrets` already exists in every deployment (0010), so the
-- columns and the index need information_schema guards behind PREPARE/EXECUTE —
-- MySQL has no `ADD COLUMN IF NOT EXISTS`. The foreign key gets the same
-- treatment plus an orphan sweep, because drizzle-orm cannot express an FK, so a
-- database built from schema.ts or `drizzle-kit push` arrives here without one.

SET @needs_host := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'secrets'
     AND COLUMN_NAME = 'source_host_id'
);
SET @ddl := IF(
  @needs_host,
  'ALTER TABLE secrets ADD COLUMN source_host_id BIGINT UNSIGNED NULL AFTER engine',
  'DO 0'
);
PREPARE add_host FROM @ddl;
EXECUTE add_host;
DEALLOCATE PREPARE add_host;

SET @needs_engine := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'secrets'
     AND COLUMN_NAME = 'source_engine'
);
SET @ddl := IF(
  @needs_engine,
  'ALTER TABLE secrets ADD COLUMN source_engine VARCHAR(16) NULL AFTER source_host_id',
  'DO 0'
);
PREPARE add_engine FROM @ddl;
EXECUTE add_engine;
DEALLOCATE PREPARE add_engine;

SET @needs_idx := (
  SELECT COUNT(*) = 0
    FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'secrets'
     AND INDEX_NAME = 'idx_secrets_source_host'
);
SET @ddl := IF(
  @needs_idx,
  'ALTER TABLE secrets ADD INDEX idx_secrets_source_host (source_host_id)',
  'DO 0'
);
PREPARE add_idx FROM @ddl;
EXECUTE add_idx;
DEALLOCATE PREPARE add_idx;

-- ON DELETE SET NULL, not CASCADE: de-registering a host must not destroy the
-- credentials it happened to create. The row survives and becomes
-- operator-owned, which is the safe direction. The sweep before ADD CONSTRAINT
-- is a no-op on a healthy database and required on one that already points at a
-- deleted host, since ADD CONSTRAINT fails outright when orphans exist.
UPDATE secrets s LEFT JOIN hosts h ON h.id = s.source_host_id
   SET s.source_host_id = NULL
 WHERE s.source_host_id IS NOT NULL AND h.id IS NULL;

SET @needs_fk := (
  SELECT COUNT(*) = 0
    FROM information_schema.TABLE_CONSTRAINTS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'secrets'
     AND CONSTRAINT_NAME = 'fk_secrets_source_host'
     AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @needs_fk,
  'ALTER TABLE secrets ADD CONSTRAINT fk_secrets_source_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL',
  'DO 0'
);
PREPARE add_fk FROM @ddl;
EXECUTE add_fk;
DEALLOCATE PREPARE add_fk;
