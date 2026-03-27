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

    public function testDashboardJsKeepsChartShellStableDuringLiveRefresh(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('DASHBOARD_CHART_AUTO_REFRESH_MS', $js);
        $this->assertStringContainsString('Live history refresh paused', $js);
        $this->assertStringContainsString('hasChartShell', $js);
    }

    public function testDashboardJsClampsQuotaChartsToZeroThroughHundredPercent(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('Math.max(0, Math.min(100, val))', $js);
        $this->assertStringContainsString('clamp(val, 0, 100)', $js);
        $this->assertStringContainsString('max: 100', $js);
        $this->assertStringContainsString('min: 0', $js);
    }

    public function testDashboardJsSupportsNewStructuredNavigationShortcuts(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString("a: '/admin/hosts'", $js);
        $this->assertStringContainsString("n: '__new_host__'", $js);
        $this->assertStringContainsString("c: '/admin/logs'", $js);
        $this->assertStringContainsString("p: '/admin/settings/projects'", $js);
        $this->assertStringContainsString("normalizedKey === 'd'", $js);
        $this->assertStringContainsString("normalizedKey === 't'", $js);
        $this->assertStringContainsString('triggerVisibleTogglerShortcut', $js);
    }
}
