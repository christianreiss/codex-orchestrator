<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

/**
 * Creates structured storage tables for Claude usage tracking.
 *
 * - claude_usage_snapshots: structured snapshot storage (replaces KV blob)
 * - dashboard_graph_claude_daily_stats: per-model daily token/cost stats
 * - dashboard_graph_claude_quota_snapshots: spend quota history for charting
 */
class ClaudeUsageSnapshotsMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS claude_usage_snapshots (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                status VARCHAR(32) NOT NULL DEFAULT 'ok',
                spend_used DECIMAL(12,6) DEFAULT NULL,
                spend_limit DECIMAL(12,6) DEFAULT NULL,
                total_cost_24h DECIMAL(12,6) DEFAULT NULL,
                total_cost_7d DECIMAL(12,6) DEFAULT NULL,
                total_cost_30d DECIMAL(12,6) DEFAULT NULL,
                models_json LONGTEXT DEFAULT NULL,
                fetched_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_created (created_at),
                INDEX idx_fetched (fetched_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS dashboard_graph_claude_daily_stats (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                date_bucket DATE NOT NULL,
                model VARCHAR(128) NOT NULL DEFAULT 'unknown',
                input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
                output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
                cached_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
                cost DECIMAL(12,6) NOT NULL DEFAULT 0,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY uk_date_model (date_bucket, model),
                INDEX idx_date (date_bucket)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS dashboard_graph_claude_quota_snapshots (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                spend_used DECIMAL(12,6) NOT NULL DEFAULT 0,
                spend_limit DECIMAL(12,6) DEFAULT NULL,
                spend_percent DECIMAL(8,4) DEFAULT NULL,
                snapshot_at VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_snapshot (snapshot_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );
    }
}
