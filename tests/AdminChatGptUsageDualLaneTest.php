<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminChatGptUsageDualLaneTest extends TestCase
{
    public function testDashboardSupportsNormalAndSparkQuotaLanes(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("renderUsageWindowCard('5-hour limit'", $js);
        $this->assertStringContainsString("renderUsageWindowCard('Weekly limit'", $js);
        $this->assertStringContainsString("{ label: 'Spark', data: sparkPrimary, windowKey: 'spark:primary' }", $js);
        $this->assertStringContainsString('active_quota_lane', $js);
        $this->assertStringContainsString('spark_primary_used_percent', $js);
        $this->assertStringContainsString('spark:primary', $js);
        $this->assertStringContainsString("querySelectorAll('.usage-lane')", $js);
    }
}
