<?php

namespace App\Migrations;

use PDO;

class InfrastructureMigration implements MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS versions (
                name VARCHAR(191) NOT NULL PRIMARY KEY,
                version VARCHAR(191) NOT NULL,
                updated_at VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
