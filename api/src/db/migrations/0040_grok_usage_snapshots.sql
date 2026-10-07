-- Keep the last successful account-scoped reading through temporary poll failures.
-- No credentials or raw billing response are stored here.
CREATE TABLE IF NOT EXISTS grok_usage_snapshots (
  account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  used_percent DOUBLE NULL,
  period_type VARCHAR(16) NULL,
  period_starts_at VARCHAR(100) NULL,
  period_resets_at VARCHAR(100) NULL,
  shared TINYINT NULL,
  fetched_at VARCHAR(100) NULL,
  checked_at VARCHAR(100) NOT NULL,
  error_code VARCHAR(48) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
