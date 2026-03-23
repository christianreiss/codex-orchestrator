<?php

namespace App\Migrations;

use PDO;

class UsageMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        $pdo->exec(
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

        // Backfill columns.
        $this->ensureColumnExists($pdo, $databaseName, 'token_usages', 'ingest_id', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'token_usages', 'reasoning_tokens', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'token_usages', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'token_usage_ingests', 'cost', 'DECIMAL(18,6) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_limit_name', 'VARCHAR(128) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_metered_feature', 'VARCHAR(128) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_rate_allowed', 'TINYINT(1) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_rate_limit_reached', 'TINYINT(1) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_primary_used_percent', 'INT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_primary_limit_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_primary_reset_after_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_primary_reset_at', 'VARCHAR(100) NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_secondary_used_percent', 'INT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_secondary_limit_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_secondary_reset_after_seconds', 'BIGINT UNSIGNED NULL');
        $this->ensureColumnExists($pdo, $databaseName, 'chatgpt_usage_snapshots', 'spark_secondary_reset_at', 'VARCHAR(100) NULL');
        $this->ensureIndexExists($pdo, $databaseName, 'token_usages', 'idx_token_usage_ingest', 'INDEX idx_token_usage_ingest (ingest_id)');
        $this->ensureForeignKeyExists($pdo, $databaseName, 'token_usages', 'fk_token_usage_ingest', 'FOREIGN KEY (ingest_id) REFERENCES token_usage_ingests(id) ON DELETE SET NULL');
    }
}
