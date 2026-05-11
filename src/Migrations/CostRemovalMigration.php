<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

class CostRemovalMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        unset($collation);

        $this->dropTableIfExists($pdo, $databaseName, 'pricing_snapshots');

        foreach ([
            'token_usages' => ['cost'],
            'token_usage_ingests' => ['cost'],
            'dashboard_graph_usage_daily_stats' => ['cost'],
            'claude_usage_snapshots' => ['spend_used', 'spend_limit', 'total_cost_24h', 'total_cost_7d', 'total_cost_30d'],
            'dashboard_graph_claude_daily_stats' => ['cost'],
            'dashboard_graph_claude_quota_snapshots' => ['spend_used', 'spend_limit', 'spend_percent'],
        ] as $table => $columns) {
            foreach ($columns as $column) {
                $this->dropColumnIfExists($pdo, $databaseName, $table, $column);
            }
        }
    }

    private function dropTableIfExists(PDO $pdo, string $databaseName, string $table): void
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table'
        );
        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
        ]);

        if ((int) $statement->fetchColumn() === 0) {
            return;
        }

        $pdo->exec(sprintf('DROP TABLE %s', $table));
    }

    private function dropColumnIfExists(PDO $pdo, string $databaseName, string $table, string $column): void
    {
        if (!$this->columnExists($pdo, $databaseName, $table, $column)) {
            return;
        }

        $pdo->exec(sprintf('ALTER TABLE %s DROP COLUMN %s', $table, $column));
    }
}
