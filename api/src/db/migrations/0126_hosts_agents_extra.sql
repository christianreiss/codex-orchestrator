-- Optional per-host instructions appended to the fleet AGENTS.md / CLAUDE.md /
-- Grok AGENTS.md served to that one host (services/host-agents.ts). Operator-
-- authored, capped at 32 KiB by the admin route; NULL means "none".
-- Additive and idempotent: MySQL has no ADD COLUMN IF NOT EXISTS.
SET @needs_hosts_agents_extra := (
  SELECT COUNT(*) = 0
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'hosts'
     AND COLUMN_NAME = 'agents_extra'
);
SET @hosts_agents_extra_ddl := IF(
  @needs_hosts_agents_extra,
  'ALTER TABLE hosts ADD COLUMN agents_extra TEXT NULL',
  'DO 0'
);
PREPARE add_hosts_agents_extra FROM @hosts_agents_extra_ddl;
EXECUTE add_hosts_agents_extra;
DEALLOCATE PREPARE add_hosts_agents_extra;
