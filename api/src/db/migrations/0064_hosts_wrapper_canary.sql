-- Canary membership for staged cxx rollouts (services/wrapper-rollout.ts).
-- A canary host receives a newly published cxx release before every wave.
-- Additive and idempotent: MySQL has no ADD COLUMN IF NOT EXISTS.
SET @needs_hosts_wrapper_canary := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'hosts'
     AND COLUMN_NAME = 'wrapper_canary'
);
SET @hosts_wrapper_canary_ddl := IF(
  @needs_hosts_wrapper_canary,
  'ALTER TABLE hosts ADD COLUMN wrapper_canary TINYINT NOT NULL DEFAULT 0',
  'DO 0'
);
PREPARE add_hosts_wrapper_canary FROM @hosts_wrapper_canary_ddl;
EXECUTE add_hosts_wrapper_canary;
DEALLOCATE PREPARE add_hosts_wrapper_canary;
