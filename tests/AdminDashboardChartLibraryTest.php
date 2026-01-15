<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardChartLibraryTest extends TestCase
{
    public function testDashboardIncludesUplotAssets(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('uPlot.min.css', $html);
        $this->assertStringContainsString('uPlot.min.js', $html);
    }

    public function testDashboardUsesUplotChartHooks(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('window.uPlot', $js);
        $this->assertStringContainsString('data-cost-plot', $js);
        $this->assertStringContainsString('data-usage-plot', $js);
    }
}
