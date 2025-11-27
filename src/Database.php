<?php

namespace App;

use PDO;
use PDOException;

class Database
{
    private PDO $pdo;
    private string $databaseName;

    /**
     * Set up a MySQL connection using the provided configuration array.
     * Expected keys: driver, host, port, database, username, password, charset.
     */
    public function __construct(array $config)
    {
        $driver = strtolower((string) ($config['driver'] ?? 'mysql'));
        if ($driver !== 'mysql') {
            throw new PDOException('Unsupported database driver: ' . $driver);
        }

        $this->databaseName = (string) ($config['database'] ?? 'codex_auth');
        $host = (string) ($config['host'] ?? 'mysql');
        $port = (int) ($config['port'] ?? 3306);
        $username = (string) ($config['username'] ?? 'root');
        $password = (string) ($config['password'] ?? '');
        $charset = (string) ($config['charset'] ?? 'utf8mb4');

        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $host,
            $port,
            $this->databaseName,
            $charset
        );

        $this->pdo = new PDO($dsn, $username, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => true,
        ]);
    }

    public function connection(): PDO
    {
        return $this->pdo;
    }

    public function migrate(): void
    {
        $collation = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS hosts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fqdn VARCHAR(255) NOT NULL UNIQUE,
                api_key CHAR(64) NOT NULL UNIQUE,
                api_key_hash CHAR(64) NULL,
                api_key_enc LONGTEXT NULL,
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
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS auth_payloads (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                last_refresh VARCHAR(100) NOT NULL,
                sha256 CHAR(64) NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_auth_payloads_last_refresh (last_refresh),
                INDEX idx_auth_payloads_created_at (created_at),
                CONSTRAINT fk_payload_source_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS auth_entries (
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
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS slash_commands (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                filename VARCHAR(255) NOT NULL UNIQUE,
                sha256 CHAR(64) NOT NULL,
                description TEXT NULL,
                argument_hint VARCHAR(255) NULL,
                prompt LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                deleted_at VARCHAR(100) NULL,
                INDEX idx_slash_commands_updated_at (updated_at),
                CONSTRAINT fk_slash_commands_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_auth_states (
                host_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                payload_id BIGINT UNSIGNED NOT NULL,
                seen_digest CHAR(64) NOT NULL,
                seen_at VARCHAR(100) NOT NULL,
                CONSTRAINT fk_state_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE,
                CONSTRAINT fk_state_payload FOREIGN KEY (payload_id) REFERENCES auth_payloads(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS logs (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                action VARCHAR(64) NOT NULL,
                details LONGTEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_logs_host (host_id),
                INDEX idx_logs_created_at (created_at),
                CONSTRAINT fk_logs_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS install_tokens (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token CHAR(36) NOT NULL UNIQUE,
                host_id BIGINT UNSIGNED NOT NULL,
                fqdn VARCHAR(255) NOT NULL,
                api_key CHAR(64) NOT NULL,
                base_url VARCHAR(255) NULL,
                expires_at VARCHAR(100) NOT NULL,
                used_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_install_tokens_host (host_id),
                INDEX idx_install_tokens_expires_at (expires_at),
                CONSTRAINT fk_install_tokens_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS token_usages (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                total BIGINT UNSIGNED NULL,
                input_tokens BIGINT UNSIGNED NULL,
                output_tokens BIGINT UNSIGNED NULL,
                cached_tokens BIGINT UNSIGNED NULL,
                reasoning_tokens BIGINT UNSIGNED NULL,
                model VARCHAR(128) NULL,
                line TEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_token_usage_host (host_id),
                INDEX idx_token_usage_created_at (created_at),
                CONSTRAINT fk_token_usage_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS chatgpt_usage_snapshots (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                status VARCHAR(16) NOT NULL,
                plan_type VARCHAR(64) NULL,
                rate_allowed TINYINT(1) NULL,
                rate_limit_reached TINYINT(1) NULL,
                primary_used_percent INT UNSIGNED NULL,
                primary_limit_seconds BIGINT UNSIGNED NULL,
                primary_reset_after_seconds BIGINT UNSIGNED NULL,
                primary_reset_at VARCHAR(100) NULL,
                secondary_used_percent INT UNSIGNED NULL,
                secondary_limit_seconds BIGINT UNSIGNED NULL,
                secondary_reset_after_seconds BIGINT UNSIGNED NULL,
                secondary_reset_at VARCHAR(100) NULL,
                has_credits TINYINT(1) NULL,
                unlimited TINYINT(1) NULL,
                credit_balance VARCHAR(128) NULL,
                approx_local_messages TEXT NULL,
                approx_cloud_messages TEXT NULL,
                raw LONGTEXT NULL,
                error TEXT NULL,
                fetched_at VARCHAR(100) NOT NULL,
                next_eligible_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_chatgpt_usage_host (host_id),
                INDEX idx_chatgpt_usage_fetched (fetched_at),
                CONSTRAINT fk_chatgpt_usage_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS pricing_snapshots (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                model VARCHAR(128) NOT NULL,
                currency VARCHAR(8) NOT NULL DEFAULT 'USD',
                input_price_per_1k DECIMAL(12,6) NOT NULL DEFAULT 0,
                output_price_per_1k DECIMAL(12,6) NOT NULL DEFAULT 0,
                cached_price_per_1k DECIMAL(12,6) NOT NULL DEFAULT 0,
                source_url TEXT NULL,
                raw LONGTEXT NULL,
                fetched_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_pricing_model (model),
                INDEX idx_pricing_fetched (fetched_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_auth_digests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                digest VARCHAR(128) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY unique_host_digest (host_id, digest),
                INDEX idx_auth_digest_host (host_id),
                CONSTRAINT fk_digests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                username VARCHAR(255) NOT NULL,
                hostname VARCHAR(255) NULL,
                first_seen VARCHAR(100) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_host_user (host_id, username),
                INDEX idx_host_users_host (host_id),
                CONSTRAINT fk_host_users_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                username VARCHAR(255) NOT NULL,
                hostname VARCHAR(255) NULL,
                first_seen VARCHAR(100) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_host_user (host_id, username),
                INDEX idx_host_users_host (host_id),
                CONSTRAINT fk_host_users_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS versions (
                name VARCHAR(191) NOT NULL PRIMARY KEY,
                version VARCHAR(191) NOT NULL,
                updated_at VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill new columns for existing databases.
        $this->ensureColumnExists('hosts', 'ip', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'client_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'wrapper_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'auth_digest', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('hosts', 'api_calls', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'allow_roaming_ips', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'api_key_hash', 'CHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('auth_payloads', 'body', 'LONGTEXT NULL');
        $this->ensureColumnExists('install_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnExists('token_usages', 'reasoning_tokens', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('slash_commands', 'deleted_at', 'VARCHAR(100) NULL');

        // Legacy inline auth storage was removed in the initial MySQL migration.
        // This column cleanup is intentionally skipped on modern deployments to avoid
        // extra information_schema lookups on every boot.
    }

    private function ensureColumnExists(string $table, string $column, string $definition): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
    }

    private function dropColumnIfExists(string $table, string $column): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if (!$exists) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s DROP COLUMN %s', $table, $column));
    }
}
