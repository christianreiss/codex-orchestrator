<?php

namespace App\Migrations;

use PDO;

class AuthMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS cli_auth_requests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                request_id CHAR(64) NOT NULL UNIQUE,
                request_id_enc LONGTEXT NULL,
                user_code CHAR(9) NOT NULL,
                user_code_hash CHAR(64) NOT NULL,
                fqdn VARCHAR(255) NOT NULL,
                secure TINYINT(1) NOT NULL DEFAULT 1,
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                approved_by_user_id BIGINT UNSIGNED NULL,
                host_id BIGINT UNSIGNED NULL,
                api_key_enc LONGTEXT NULL,
                ip VARCHAR(64) NULL,
                user_agent VARCHAR(255) NULL,
                expires_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                approved_at VARCHAR(100) NULL,
                consumed_at VARCHAR(100) NULL,
                INDEX idx_cli_auth_user_code (user_code_hash),
                INDEX idx_cli_auth_expires (expires_at),
                INDEX idx_cli_auth_status (status)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill columns.
        $this->ensureColumnExists($pdo, $databaseName, 'auth_payloads', 'body', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'install_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'install_tokens', 'token_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'install_tokens', 'api_key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'auth_seed_tokens', 'token_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'auth_seed_tokens', 'base_url', 'VARCHAR(255) NULL');
        $this->ensureColumnLength($pdo, $databaseName, 'install_tokens', 'token', 64);
        $this->ensureColumnLength($pdo, $databaseName, 'auth_seed_tokens', 'token', 64);
    }
}
