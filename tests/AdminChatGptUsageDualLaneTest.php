<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminChatGptUsageDualLaneTest extends TestCase
{
    public function testDashboardSupportsNormalAndSparkQuotaLanes(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('Normal · 5-hour limit', $js);
        $this->assertStringContainsString('Spark · 5-hour limit', $js);
        $this->assertStringContainsString('active_quota_lane', $js);
        $this->assertStringContainsString('spark_primary_used_percent', $js);
        $this->assertStringContainsString('spark:primary', $js);
    }
}
