# DB Contract Tests

## Pre-flight
- Ensure MySQL credentials match `.env` / `docker-compose.yml` (`DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`).
- Run migrations once to normalize columns: `php -r "require 'vendor/autoload.php'; (new App\\Database(['driver'=>'mysql','host'=>getenv('DB_HOST'),'port'=>getenv('DB_PORT'),'database'=>getenv('DB_DATABASE'),'username'=>getenv('DB_USERNAME'),'password'=>getenv('DB_PASSWORD'),'charset'=>getenv('DB_CHARSET') ?: 'utf8mb4']))->migrate();"` (adjust env exports as needed).

## Schema presence checks (MySQL)
- List tables: `SHOW TABLES;` → expect `auth_entries`, `auth_payloads`, `host_auth_digests`, `host_auth_states`, `hosts`, `logs`, `token_usages`, `versions`.
- Confirm required columns for a table (example for `hosts`):
  ```sql
  SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'hosts'
  ORDER BY ORDINAL_POSITION;
  ```
- Check the `body` column backfill on `auth_payloads`:
  ```sql
  SELECT COLUMN_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_payloads' AND COLUMN_NAME = 'body';
  ```
- Verify unique keys on `hosts`:
  ```sql
  SHOW INDEX FROM hosts WHERE Key_name IN ('PRIMARY','fqdn','api_key');
  ```

## Foreign key integrity
```sql
SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc USING (CONSTRAINT_SCHEMA, CONSTRAINT_NAME)
WHERE k.TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, COLUMN_NAME;
```
Expect:
- `auth_payloads.source_host_id` → `hosts.id` (ON DELETE SET NULL)
- `auth_entries.payload_id` → `auth_payloads.id` (CASCADE)
- `host_auth_states.host_id` → `hosts.id` (CASCADE)
- `host_auth_states.payload_id` → `auth_payloads.id` (CASCADE)
- `host_auth_digests.host_id` → `hosts.id` (CASCADE)
- `logs.host_id` → `hosts.id` (SET NULL)
- `token_usages.host_id` → `hosts.id` (SET NULL)

## Sample DDL (MySQL 8, utf8mb4_unicode_ci)
```sql
CREATE TABLE hosts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fqdn VARCHAR(255) NOT NULL UNIQUE,
  api_key CHAR(64) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  allow_roaming_ips TINYINT(1) NOT NULL DEFAULT 0,
  last_refresh VARCHAR(100) NULL,
  auth_digest VARCHAR(128) NULL,
  ip VARCHAR(64) NULL,
  client_version VARCHAR(64) NULL,
  wrapper_version VARCHAR(64) NULL,
  api_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at VARCHAR(100) NOT NULL,
  updated_at VARCHAR(100) NOT NULL,
  INDEX idx_hosts_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE auth_payloads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  last_refresh VARCHAR(100) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  source_host_id BIGINT UNSIGNED NULL,
  body LONGTEXT NULL,
  created_at VARCHAR(100) NOT NULL,
  INDEX idx_auth_payloads_last_refresh (last_refresh),
  INDEX idx_auth_payloads_created_at (created_at),
  CONSTRAINT fk_payload_source_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE auth_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payload_id BIGINT UNSIGNED NOT NULL,
  target VARCHAR(255) NOT NULL,
  token TEXT NOT NULL,
  token_type VARCHAR(32) DEFAULT 'bearer',
  organization VARCHAR(255) NULL,
  project VARCHAR(255) NULL,
  api_base VARCHAR(255) NULL,
  meta JSON NULL,
  created_at VARCHAR(100) NOT NULL,
  INDEX idx_entries_payload (payload_id),
  UNIQUE KEY uniq_entry_target (payload_id, target),
  CONSTRAINT fk_entries_payload FOREIGN KEY (payload_id) REFERENCES auth_payloads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE host_auth_states (
  host_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  payload_id BIGINT UNSIGNED NOT NULL,
  seen_digest CHAR(64) NOT NULL,
  seen_at VARCHAR(100) NOT NULL,
  CONSTRAINT fk_state_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE,
  CONSTRAINT fk_state_payload FOREIGN KEY (payload_id) REFERENCES auth_payloads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  host_id BIGINT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  details LONGTEXT NULL,
  created_at VARCHAR(100) NOT NULL,
  INDEX idx_logs_host (host_id),
  INDEX idx_logs_created_at (created_at),
  CONSTRAINT fk_logs_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE token_usages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  host_id BIGINT UNSIGNED NULL,
  total BIGINT UNSIGNED NULL,
  input_tokens BIGINT UNSIGNED NULL,
  output_tokens BIGINT UNSIGNED NULL,
  cached_tokens BIGINT UNSIGNED NULL,
  model VARCHAR(128) NULL,
  line TEXT NULL,
  created_at VARCHAR(100) NOT NULL,
  INDEX idx_token_usage_host (host_id),
  INDEX idx_token_usage_created_at (created_at),
  CONSTRAINT fk_token_usage_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE host_auth_digests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  host_id BIGINT UNSIGNED NOT NULL,
  digest VARCHAR(128) NOT NULL,
  last_seen VARCHAR(100) NOT NULL,
  created_at VARCHAR(100) NOT NULL,
  UNIQUE KEY unique_host_digest (host_id, digest),
  INDEX idx_auth_digest_host (host_id),
  CONSTRAINT fk_digests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE versions (
  name VARCHAR(191) NOT NULL PRIMARY KEY,
  version VARCHAR(191) NOT NULL,
  updated_at VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## Behavioral assertions
- After a successful `/auth store`, expect:
  - One new row in `auth_payloads` and accompanying rows in `auth_entries`.
  - `versions` row where `name='canonical_payload_id'` pointing to that payload id.
  - `hosts.last_refresh`/`auth_digest` updated for the caller; `host_auth_states` upserted.
- After `/auth retrieve` with a matching digest, `host_auth_states.seen_digest` should match `hosts.auth_digest`; `api_calls` increments by 1.
- `host_auth_digests` should contain at most 3 rows per host (check `SELECT COUNT(*) FROM host_auth_digests WHERE host_id=?;`).
- Inactivity pruning: hosts with `updated_at` older than 30 days are deleted on any auth/register call; verify by setting an old `updated_at` and hitting `/auth`.

## Migration validation (SQLite → MySQL)
1. Run `php bin/migrate-sqlite-to-mysql.php --sqlite <path> [--force]`.
2. Re-run the schema checks above to ensure columns (especially `body`, `allow_roaming_ips`, `api_calls`) exist.
3. Compare counts:
   ```sql
   SELECT (SELECT COUNT(*) FROM hosts) AS hosts,
          (SELECT COUNT(*) FROM logs) AS logs,
          (SELECT COUNT(*) FROM host_auth_digests) AS digests,
          (SELECT COUNT(*) FROM versions) AS versions;
   ```
4. Manually push a canonical auth via `/auth store` to repopulate `auth_payloads`/`auth_entries`, since the migration script does not copy those tables.

