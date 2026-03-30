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

    public function testNavigationShowsShortcutHints(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('All Hosts</span><span class="rail-shortcut">[h][a]</span>', $html);
        $this->assertStringContainsString('New Host</span><span class="rail-shortcut">[h][n]</span>', $html);
        $this->assertStringContainsString('API Logs</span><span class="rail-shortcut">[l][c]</span>', $html);
        $this->assertStringContainsString('General</span><span class="rail-shortcut">[s][g]</span>', $html);
        $this->assertStringContainsString('Projects</span><span class="rail-shortcut">[s][p]</span>', $html);
        $this->assertStringContainsString('Keyboard shortcuts</span>', $html);
        $this->assertStringContainsString('<span class="rail-shortcut">[?]</span>', $html);
        $this->assertStringNotContainsString('Overview</span><span class="rail-shortcut">', $html);
        $this->assertStringContainsString('Users</span><span class="rail-shortcut">[s][u]</span>', $html);
    }
}
