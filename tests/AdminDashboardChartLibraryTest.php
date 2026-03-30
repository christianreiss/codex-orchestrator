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

    public function testNewHostModalUsesHostnameCopyAndOptionGrid(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('<div class="modal new-host-modal">', $html);
        $this->assertStringContainsString('Fresh machine, one command.', $html);
        $this->assertStringContainsString('Spin Up a Host', $html);
        $this->assertStringContainsString('Pick a hostname, choose the guardrails, and we will mint a one-time installer', $html);
        $this->assertStringContainsString('>Hostname</label>', $html);
        $this->assertStringContainsString('class="new-host-toggle-grid"', $html);
        $this->assertStringContainsString('new-host-option-title">Secure</span>', $html);
        $this->assertStringContainsString('new-host-option-title">Temporary</span>', $html);
        $this->assertStringContainsString('new-host-option-title">Insecure Curl</span>', $html);
        $this->assertStringContainsString('new-host-option-title">VIP</span>', $html);
        $this->assertStringContainsString('Mint Installer</button>', $html);
        $this->assertStringNotContainsString('Issue a one-time installer link for this FQDN.', $html);
        $this->assertStringNotContainsString('Host FQDN', $html);

        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('.new-host-modal {', $css);
        $this->assertStringContainsString('.new-host-toggle-grid {', $css);
        $this->assertStringContainsString('grid-template-columns: repeat(2, minmax(0, 1fr));', $css);
        $this->assertStringContainsString('.new-host-option-title {', $css);
        $this->assertStringContainsString('.new-host-option-desc {', $css);
    }
}
