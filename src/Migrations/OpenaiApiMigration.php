<?php

namespace App\Migrations;

use PDO;

class OpenaiApiMigration implements MigrationInterface
{
    use MigrationHelper;

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
                use_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
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

        // Older installs may already have the table from an earlier schema cut.
        // Keep the migration additive so restart/manual migrate heals drift in place.
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'key_enc', 'LONGTEXT NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'admin_user_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'rate_limit_rpm', 'INT UNSIGNED NOT NULL DEFAULT 60');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'use_count', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'last_used_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'expires_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'openai_api_keys', 'updated_at', 'VARCHAR(100) NOT NULL DEFAULT \'\'');

        $this->ensureIndexExists($pdo, $databaseName, 'openai_api_keys', 'key_hash', 'UNIQUE INDEX key_hash (key_hash)');
        $this->ensureIndexExists($pdo, $databaseName, 'openai_api_keys', 'idx_openai_keys_active', 'INDEX idx_openai_keys_active (is_active)');
        $this->ensureIndexExists($pdo, $databaseName, 'openai_api_keys', 'idx_openai_keys_prefix', 'INDEX idx_openai_keys_prefix (key_prefix)');
        $this->ensureIndexExists($pdo, $databaseName, 'openai_api_keys', 'idx_openai_keys_admin', 'INDEX idx_openai_keys_admin (admin_user_id)');
    }
}
