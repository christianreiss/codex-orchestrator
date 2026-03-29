<?php

namespace App\Migrations;

use PDO;

class OpenaiApiMigration implements MigrationInterface
{
    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS openai_api_keys (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                key_prefix VARCHAR(20) NOT NULL,
                key_hash CHAR(64) NOT NULL UNIQUE,
                key_enc LONGTEXT NULL,
                admin_user_id BIGINT UNSIGNED NULL,
                rate_limit_rpm INT UNSIGNED NOT NULL DEFAULT 60,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                last_used_at VARCHAR(100) NULL,
                expires_at VARCHAR(100) NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_openai_keys_active (is_active),
                INDEX idx_openai_keys_prefix (key_prefix),
                INDEX idx_openai_keys_admin (admin_user_id)
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
