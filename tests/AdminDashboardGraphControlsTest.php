<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardGraphControlsTest extends TestCase
{
    public function testDashboardHtmlIncludesTrendsGrid(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="dashboardTrends"', $html);
        $this->assertStringContainsString('class="dashboard-trends-grid"', $html);
        $this->assertStringNotContainsString('id="dashboardGrid"', $html);
        $this->assertStringNotContainsString('id="dashboardOpsStrip"', $html);
        $this->assertStringNotContainsString('id="dashboardFooter"', $html);
        $this->assertStringNotContainsString('chart.umd.min.js', $html);
        $this->assertStringNotContainsString('chartjs-plugin-zoom.min.js', $html);
    }

    public function testDashboardJsRendersTrendTilesInsteadOfChartJs(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('function renderDashboardTrends(', $js);
        $this->assertStringContainsString('function refreshDashboardTrends(', $js);
        $this->assertStringContainsString('function renderTrendSparkline(', $js);
        $this->assertStringContainsString('class="dashboard-trend-tile"', $js);
        $this->assertStringNotContainsString('renderDashboardGrid', $js);
        $this->assertStringNotContainsString('refreshDashboardCharts', $js);
        $this->assertStringNotContainsString('dashboardQuotaChart', $js);
        $this->assertStringNotContainsString('dashboardCostChart', $js);
        $this->assertStringNotContainsString('new window.Chart', $js);
        $this->assertStringNotContainsString('Export CSV', $js);
        $this->assertStringNotContainsString('dashboardCompareBtn', $js);
        $this->assertStringNotContainsString('dashboardTypeBtn', $js);
    }

    public function testDashboardJsKeepsLiveDebounceConstant(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('DASHBOARD_CHART_LIVE_DEBOUNCE_MS', $js);
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
