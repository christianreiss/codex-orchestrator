<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardGraphControlsTest extends TestCase
{
    public function testDashboardHtmlIncludesInlineChartContainer(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="dashboardGrid"', $html);
    }

    public function testDashboardJsWiresAdvancedGraphControls(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('dashboardCompareBtn', $js);
        $this->assertStringContainsString('dashboardTypeBtn', $js);
        $this->assertStringContainsString('dashboardQuotaReset', $js);
        $this->assertStringContainsString('dashboardCostReset', $js);
        $this->assertStringContainsString('Export CSV', $js);
        $this->assertStringContainsString('refreshDashboardCharts', $js);
    }
}
