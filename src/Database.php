<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

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
                secure TINYINT(1) NOT NULL DEFAULT 1,
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
            CREATE TABLE IF NOT EXISTS agents_documents (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sha256 CHAR(64) NOT NULL,
                body LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_agents_documents_updated_at (updated_at),
                CONSTRAINT fk_agents_documents_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS client_config_documents (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                sha256 CHAR(64) NOT NULL,
                body LONGTEXT NOT NULL,
                settings JSON NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_client_config_documents_updated_at (updated_at),
                CONSTRAINT fk_client_config_documents_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS mcp_memories (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                memory_key VARCHAR(128) NOT NULL,
                content LONGTEXT NOT NULL,
                metadata JSON NULL,
                tags JSON NULL,
                tags_text TEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                deleted_at VARCHAR(100) NULL,
                UNIQUE KEY uniq_memories_host_key (host_id, memory_key),
                INDEX idx_memories_host (host_id),
                FULLTEXT INDEX idx_memories_search (content, tags_text),
                CONSTRAINT fk_memories_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
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
            CREATE TABLE IF NOT EXISTS mcp_access_logs (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                client_ip VARCHAR(64) NULL,
                method VARCHAR(64) NOT NULL,
                name VARCHAR(128) NULL,
                success TINYINT(1) NOT NULL DEFAULT 0,
                error_code INT NULL,
                error_message TEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_mcp_logs_host (host_id),
                INDEX idx_mcp_logs_method (method),
                INDEX idx_mcp_logs_created_at (created_at),
                CONSTRAINT fk_mcp_logs_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS ip_rate_limits (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                ip VARCHAR(64) NOT NULL,
                bucket VARCHAR(64) NOT NULL,
                count INT UNSIGNED NOT NULL DEFAULT 0,
                reset_at VARCHAR(100) NOT NULL,
                last_hit VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY uniq_ip_bucket (ip, bucket),
                INDEX idx_rate_limits_reset_at (reset_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS install_tokens (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token CHAR(64) NOT NULL UNIQUE,
                token_enc LONGTEXT NULL,
                host_id BIGINT UNSIGNED NOT NULL,
                fqdn VARCHAR(255) NOT NULL,
                api_key CHAR(64) NOT NULL,
                api_key_enc LONGTEXT NULL,
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
            CREATE TABLE IF NOT EXISTS token_usage_ingests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                entries INT UNSIGNED NOT NULL DEFAULT 0,
                total BIGINT UNSIGNED NULL,
                input_tokens BIGINT UNSIGNED NULL,
                output_tokens BIGINT UNSIGNED NULL,
                cached_tokens BIGINT UNSIGNED NULL,
                reasoning_tokens BIGINT UNSIGNED NULL,
                cost DECIMAL(18,6) NULL,
                client_ip VARCHAR(64) NULL,
                payload LONGTEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_usage_ingests_host (host_id),
                INDEX idx_usage_ingests_created_at (created_at),
                CONSTRAINT fk_usage_ingests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS token_usages (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                ingest_id BIGINT UNSIGNED NULL,
                total BIGINT UNSIGNED NULL,
                input_tokens BIGINT UNSIGNED NULL,
                output_tokens BIGINT UNSIGNED NULL,
                cached_tokens BIGINT UNSIGNED NULL,
                reasoning_tokens BIGINT UNSIGNED NULL,
                cost DECIMAL(18,6) NULL,
                model VARCHAR(128) NULL,
                line TEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_token_usage_host (host_id),
                INDEX idx_token_usage_ingest (ingest_id),
                INDEX idx_token_usage_created_at (created_at),
                CONSTRAINT fk_token_usage_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL,
                CONSTRAINT fk_token_usage_ingest FOREIGN KEY (ingest_id) REFERENCES token_usage_ingests(id) ON DELETE SET NULL
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
        $this->ensureColumnExists('hosts', 'secure', 'TINYINT(1) NOT NULL DEFAULT 1');
        $this->ensureColumnExists('hosts', 'insecure_enabled_until', 'DATETIME NULL');
        $this->ensureColumnExists('hosts', 'insecure_grace_until', 'DATETIME NULL');
        $this->ensureColumnExists('hosts', 'insecure_window_minutes', 'INT NULL');
        $this->ensureColumnExists('hosts', 'force_ipv4', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'vip', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'api_key_hash', 'CHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('auth_payloads', 'body', 'LONGTEXT NULL');
        $this->ensureColumnExists('install_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnExists('install_tokens', 'token_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('install_tokens', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('token_usages', 'ingest_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('token_usages', 'reasoning_tokens', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('token_usages', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists('token_usage_ingests', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists('slash_commands', 'deleted_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('agents_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('client_config_documents', 'settings', 'JSON NULL');
        $this->ensureColumnExists('client_config_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnLength('install_tokens', 'token', 64);

        $this->ensureIndexExists('token_usages', 'idx_token_usage_ingest', 'INDEX idx_token_usage_ingest (ingest_id)');
        $this->ensureForeignKeyExists('token_usages', 'fk_token_usage_ingest', 'FOREIGN KEY (ingest_id) REFERENCES token_usage_ingests(id) ON DELETE SET NULL');

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

    private function ensureColumnLength(string $table, string $column, int $length): void
    {
        $statement = $this->pdo->prepare(
            'SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $currentLength = $statement->fetchColumn();
        if ($currentLength !== false && (int) $currentLength >= $length) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s MODIFY COLUMN %s CHAR(%d) NOT NULL', $table, $column, $length));
    }

    private function ensureIndexExists(string $table, string $index, string $definition): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND INDEX_NAME = :index'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'index' => $index,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s ADD %s', $table, $definition));
    }

    private function ensureForeignKeyExists(string $table, string $constraint, string $definition): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND CONSTRAINT_NAME = :constraint AND CONSTRAINT_TYPE = :type'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'constraint' => $constraint,
            'type' => 'FOREIGN KEY',
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s ADD CONSTRAINT %s %s', $table, $constraint, $definition));
    }

}
