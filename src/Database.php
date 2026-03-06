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
                reverse_dns_mode TINYINT(1) NULL DEFAULT NULL,
                last_refresh VARCHAR(100) NULL,
                auth_digest VARCHAR(128) NULL,
                ip4 VARCHAR(64) NULL,
                ip6 VARCHAR(64) NULL,
                client_version VARCHAR(64) NULL,
                wrapper_version VARCHAR(64) NULL,
                agents_document_id_override BIGINT UNSIGNED NULL,
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
            CREATE TABLE IF NOT EXISTS skills (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                slug VARCHAR(255) NOT NULL UNIQUE,
                sha256 CHAR(64) NOT NULL,
                display_name VARCHAR(255) NULL,
                description TEXT NULL,
                manifest LONGTEXT NOT NULL,
                source_host_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                deleted_at VARCHAR(100) NULL,
                INDEX idx_skills_updated_at (updated_at),
                CONSTRAINT fk_skills_host FOREIGN KEY (source_host_id) REFERENCES hosts(id) ON DELETE SET NULL
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
            CREATE TABLE IF NOT EXISTS agents_document_state (
                id TINYINT UNSIGNED PRIMARY KEY,
                mode VARCHAR(16) NOT NULL,
                active_document_id BIGINT UNSIGNED NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_agents_document_state_updated_at (updated_at),
                CONSTRAINT fk_agents_document_state_active FOREIGN KEY (active_document_id) REFERENCES agents_documents(id) ON DELETE SET NULL
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
            CREATE TABLE IF NOT EXISTS admin_events (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                type VARCHAR(64) NOT NULL,
                host_id BIGINT UNSIGNED NULL,
                payload JSON NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_events_host (host_id),
                INDEX idx_admin_events_type (type),
                INDEX idx_admin_events_created_at (created_at),
                CONSTRAINT fk_admin_events_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_users (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                username VARCHAR(64) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                access_level VARCHAR(32) NOT NULL,
                active TINYINT(1) NOT NULL DEFAULT 1,
                last_login_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_users_access (access_level),
                INDEX idx_admin_users_active (active)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_sessions (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                ip VARCHAR(64) NULL,
                user_agent VARCHAR(255) NULL,
                created_at VARCHAR(100) NOT NULL,
                last_seen_at VARCHAR(100) NOT NULL,
                expires_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_sessions_user (user_id),
                INDEX idx_admin_sessions_expires (expires_at),
                CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS admin_password_resets (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                user_id BIGINT UNSIGNED NOT NULL,
                token_hash CHAR(64) NOT NULL UNIQUE,
                expires_at VARCHAR(100) NOT NULL,
                used_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_admin_password_resets_user (user_id),
                INDEX idx_admin_password_resets_expires (expires_at),
                CONSTRAINT fk_admin_password_resets_user FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS insecure_auth_requests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                status VARCHAR(24) NOT NULL,
                request_ip VARCHAR(64) NULL,
                requested_at VARCHAR(100) NOT NULL,
                resolved_at VARCHAR(100) NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_insecure_auth_requests_host (host_id),
                INDEX idx_insecure_auth_requests_status (status),
                INDEX idx_insecure_auth_requests_requested_at (requested_at),
                CONSTRAINT fk_insecure_auth_requests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS insecure_domain_allows (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                domain VARCHAR(255) NOT NULL,
                window_minutes INT NOT NULL,
                enabled_until VARCHAR(100) NULL,
                revoked_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                UNIQUE KEY idx_insecure_domain_allows_domain (domain),
                INDEX idx_insecure_domain_allows_enabled_until (enabled_until),
                INDEX idx_insecure_domain_allows_revoked_at (revoked_at)
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
            CREATE TABLE IF NOT EXISTS mcp_session_tokens (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token CHAR(64) NOT NULL UNIQUE,
                token_enc LONGTEXT NULL,
                host_id BIGINT UNSIGNED NOT NULL,
                expires_at VARCHAR(100) NOT NULL,
                last_used_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_mcp_session_tokens_host (host_id),
                INDEX idx_mcp_session_tokens_expires_at (expires_at),
                CONSTRAINT fk_mcp_session_tokens_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
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
            CREATE TABLE IF NOT EXISTS auth_seed_tokens (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token CHAR(64) NOT NULL UNIQUE,
                token_enc LONGTEXT NULL,
                base_url VARCHAR(255) NULL,
                expires_at VARCHAR(100) NOT NULL,
                used_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_auth_seed_tokens_expires_at (expires_at)
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
                spark_limit_name VARCHAR(128) NULL,
                spark_metered_feature VARCHAR(128) NULL,
                spark_rate_allowed TINYINT(1) NULL,
                spark_rate_limit_reached TINYINT(1) NULL,
                spark_primary_used_percent INT UNSIGNED NULL,
                spark_primary_limit_seconds BIGINT UNSIGNED NULL,
                spark_primary_reset_after_seconds BIGINT UNSIGNED NULL,
                spark_primary_reset_at VARCHAR(100) NULL,
                spark_secondary_used_percent INT UNSIGNED NULL,
                spark_secondary_limit_seconds BIGINT UNSIGNED NULL,
                spark_secondary_reset_after_seconds BIGINT UNSIGNED NULL,
                spark_secondary_reset_at VARCHAR(100) NULL,
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
            CREATE TABLE IF NOT EXISTS versions (
                name VARCHAR(191) NOT NULL PRIMARY KEY,
                version VARCHAR(191) NOT NULL,
                updated_at VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill new columns for existing databases.
        $this->ensureColumnExists('hosts', 'ip4', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'ip6', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'client_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'client_version_override', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'agents_document_id_override', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('hosts', 'wrapper_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'auth_digest', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('hosts', 'api_calls', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'allow_roaming_ips', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'secure', 'TINYINT(1) NOT NULL DEFAULT 1');
        $this->ensureColumnExists('hosts', 'reverse_dns_mode', 'TINYINT(1) NULL DEFAULT NULL');
        $this->ensureColumnExists('hosts', 'insecure_enabled_until', 'DATETIME NULL');
        $this->ensureColumnExists('hosts', 'insecure_grace_until', 'DATETIME NULL');
        $this->ensureColumnExists('hosts', 'insecure_window_minutes', 'INT NULL');
        $this->ensureColumnExists('hosts', 'force_ipv4', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'curl_insecure', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->migrateHostIpColumns();
        $this->ensureColumnExists('hosts', 'expires_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('hosts', 'vip', 'TINYINT(1) NOT NULL DEFAULT 0');
        $this->ensureColumnExists('hosts', 'lane_preference', 'VARCHAR(16) NULL');
        $this->ensureColumnExists('hosts', 'model_override', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('hosts', 'reasoning_effort_override', 'VARCHAR(32) NULL');
        $this->ensureColumnExists('hosts', 'api_key_hash', 'CHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('auth_payloads', 'body', 'LONGTEXT NULL');
        $this->ensureColumnExists('install_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnExists('install_tokens', 'token_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('install_tokens', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('auth_seed_tokens', 'token_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists('auth_seed_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnExists('token_usages', 'ingest_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('token_usages', 'reasoning_tokens', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('token_usages', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists('token_usage_ingests', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_limit_name', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_metered_feature', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_rate_allowed', 'TINYINT(1) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_rate_limit_reached', 'TINYINT(1) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_primary_used_percent', 'INT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_primary_limit_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_primary_reset_after_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_primary_reset_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_secondary_used_percent', 'INT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_secondary_limit_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_secondary_reset_after_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('chatgpt_usage_snapshots', 'spark_secondary_reset_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('slash_commands', 'deleted_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('skills', 'deleted_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists('agents_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists('client_config_documents', 'settings', 'JSON NULL');
        $this->ensureColumnExists('client_config_documents', 'source_host_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnLength('install_tokens', 'token', 64);
        $this->ensureColumnLength('auth_seed_tokens', 'token', 64);
        $this->ensureIndexExists('hosts', 'idx_hosts_expires_at', 'INDEX idx_hosts_expires_at (expires_at)');
        $this->ensureIndexExists('token_usages', 'idx_token_usage_ingest', 'INDEX idx_token_usage_ingest (ingest_id)');
        $this->ensureForeignKeyExists('token_usages', 'fk_token_usage_ingest', 'FOREIGN KEY (ingest_id) REFERENCES token_usage_ingests(id) ON DELETE SET NULL');

        // Clean up deprecated/removed tables.
        $this->dropTableIfExists('admin_passkeys');

        // Legacy inline auth storage was removed in the initial MySQL migration.
        // This column cleanup is intentionally skipped on modern deployments to avoid
        // extra information_schema lookups on every boot.
    }

    private function migrateHostIpColumns(): void
    {
        $hasIp = $this->columnExists('hosts', 'ip');
        $hasIpAlt = $this->columnExists('hosts', 'ip_alt');
        $hasIp4 = $this->columnExists('hosts', 'ip4');
        $hasIp6 = $this->columnExists('hosts', 'ip6');
        $needsNormalization = false;

        if ($hasIp && !$hasIp4) {
            $this->pdo->exec('ALTER TABLE hosts CHANGE ip ip4 VARCHAR(64) NULL');
            $needsNormalization = true;
        }

        if ($hasIpAlt && !$hasIp6) {
            $this->pdo->exec('ALTER TABLE hosts CHANGE ip_alt ip6 VARCHAR(64) NULL');
            $needsNormalization = true;
        }

        $hasIp = $this->columnExists('hosts', 'ip');
        $hasIpAlt = $this->columnExists('hosts', 'ip_alt');
        $hasIp4 = $this->columnExists('hosts', 'ip4');
        $hasIp6 = $this->columnExists('hosts', 'ip6');

        if (!$hasIp4) {
            $this->ensureColumnExists('hosts', 'ip4', 'VARCHAR(64) NULL');
            $hasIp4 = true;
        }
        if (!$hasIp6) {
            $this->ensureColumnExists('hosts', 'ip6', 'VARCHAR(64) NULL');
            $hasIp6 = true;
        }

        if ($needsNormalization || $hasIp || $hasIpAlt) {
            $this->normalizeHostIpFamilies($hasIp, $hasIpAlt);
        }

        if ($hasIp) {
            $this->pdo->exec('ALTER TABLE hosts DROP COLUMN ip');
        }
        if ($hasIpAlt) {
            $this->pdo->exec('ALTER TABLE hosts DROP COLUMN ip_alt');
        }
    }

    private function normalizeHostIpFamilies(bool $hasLegacyIp, bool $hasLegacyIpAlt): void
    {
        if (!$this->columnExists('hosts', 'ip4') || !$this->columnExists('hosts', 'ip6')) {
            return;
        }

        $columns = ['id', 'ip4', 'ip6'];
        if ($hasLegacyIp && $this->columnExists('hosts', 'ip')) {
            $columns[] = 'ip';
        }
        if ($hasLegacyIpAlt && $this->columnExists('hosts', 'ip_alt')) {
            $columns[] = 'ip_alt';
        }

        $statement = $this->pdo->query('SELECT ' . implode(', ', $columns) . ' FROM hosts');
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) {
            return;
        }

        $update = $this->pdo->prepare('UPDATE hosts SET ip4 = :ip4, ip6 = :ip6 WHERE id = :id');
        foreach ($rows as $row) {
            $ip4 = $this->firstMatchingIp([
                $row['ip4'] ?? null,
                $row['ip6'] ?? null,
                $row['ip'] ?? null,
                $row['ip_alt'] ?? null,
            ], 4);
            $ip6 = $this->firstMatchingIp([
                $row['ip4'] ?? null,
                $row['ip6'] ?? null,
                $row['ip'] ?? null,
                $row['ip_alt'] ?? null,
            ], 6);

            $currentIp4 = $this->normalizeIpRaw($row['ip4'] ?? null);
            $currentIp6 = $this->normalizeIpRaw($row['ip6'] ?? null);

            if ($ip4 !== $currentIp4 || $ip6 !== $currentIp6) {
                $update->execute([
                    'ip4' => $ip4,
                    'ip6' => $ip6,
                    'id' => (int) $row['id'],
                ]);
            }
        }
    }

    private function firstMatchingIp(array $candidates, int $family): ?string
    {
        foreach ($candidates as $candidate) {
            $normalized = $this->normalizeIpValue($candidate, $family);
            if ($normalized !== null) {
                return $normalized;
            }
        }
        return null;
    }

    private function normalizeIpValue(mixed $candidate, int $family): ?string
    {
        if (!is_string($candidate)) {
            return null;
        }
        $normalized = trim($candidate);
        if ($normalized === '') {
            return null;
        }
        $flag = $family === 4 ? FILTER_FLAG_IPV4 : FILTER_FLAG_IPV6;
        if (filter_var($normalized, FILTER_VALIDATE_IP, $flag) === false) {
            return null;
        }
        return $normalized;
    }

    private function normalizeIpRaw(mixed $candidate): ?string
    {
        if (!is_string($candidate)) {
            return null;
        }
        $normalized = trim($candidate);
        return $normalized === '' ? null : $normalized;
    }

    private function columnExists(string $table, string $column): bool
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        return (int) $statement->fetchColumn() > 0;
    }

    private function dropTableIfExists(string $table): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if (!$exists) {
            return;
        }

        $this->pdo->exec(sprintf('DROP TABLE %s', $table));
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
