<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardChartLibraryTest extends TestCase
{
    public function testDashboardIncludesChartJsAssets(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('chart.umd.min.js', $html);
        $this->assertStringContainsString('chartjs-plugin-zoom.min.js', $html);
        $this->assertStringContainsString('hammer.min.js', $html);
    }

    public function testDashboardUsesChartJsDashboardHooks(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('window.Chart', $js);
        $this->assertStringContainsString('refreshDashboardCharts', $js);
        $this->assertStringContainsString('dashboardQuotaCanvas', $js);
        $this->assertStringContainsString('dashboardCostCanvas', $js);
        $this->assertStringContainsString('zoom', $js);
    }
}
