<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class DashboardGraphStatsRetentionContractTest extends TestCase
{
    public function testUsageMigrationDefinesSetAsideGraphStatsTables(): void
    {
        $php = file_get_contents(__DIR__ . '/../src/Migrations/UsageMigration.php');
        $this->assertIsString($php);

        $this->assertStringContainsString('CREATE TABLE IF NOT EXISTS dashboard_graph_usage_daily_stats', $php);
        $this->assertStringContainsString('CREATE TABLE IF NOT EXISTS dashboard_graph_quota_snapshots', $php);
        $this->assertStringContainsString('uniq_dashboard_graph_usage_day', $php);
        $this->assertStringContainsString('uniq_dashboard_graph_quota_fetched', $php);
    }

    public function testGraphStatsRetentionIsExposedAndPurgedSeparately(): void
    {
        $php = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php')
            . file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        $this->assertIsString($php);

        $this->assertStringContainsString('log_retention_days_graph_stats', $php);
        $this->assertStringContainsString("'days_graph_stats' => \$daysGraphStats", $php);
        $this->assertStringContainsString("\$this->dashboardGraphStats->deleteOlderThan(\$daysGraphStats);", $php);
    }

    public function testChartHistoryServicesUseSetAsideGraphStatsStore(): void
    {
        $php = file_get_contents(__DIR__ . '/../src/Services/DashboardGraphStatsService.php')
            . file_get_contents(__DIR__ . '/../src/Services/ChatGptUsageService.php')
            . file_get_contents(__DIR__ . '/../src/Services/TokenUsageTracker.php');
        $this->assertIsString($php);

        $this->assertStringContainsString("dashboard_graph_stats_backfill_v1", $php);
        $this->assertStringContainsString("\$this->dashboardGraphStats?->recordTokenUsage(\$aggregates, \$recordedAt);", $php);
        $this->assertStringContainsString("\$this->dashboardGraphStats?->quotaHistory(", $php);
        $this->assertStringContainsString("\$this->dashboardGraphStats?->recordQuotaSnapshot(\$snapshot);", $php);
    }
}
