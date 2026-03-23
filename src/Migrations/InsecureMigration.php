<?php

namespace App\Migrations;

use PDO;

class InsecureMigration implements MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
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

        $pdo->exec(
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
    }
}
