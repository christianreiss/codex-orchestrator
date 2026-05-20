<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardGraphControlsTest extends TestCase
{
    public function testDashboardHtmlIncludesTrendsGrid(): void
    {
        // The SvelteKit dashboard page renders stat cards and usage cards –
        // there are no legacy dashboardGrid / dashboardOpsStrip / dashboardFooter IDs.
        $page = file_get_contents(__DIR__ . '/../frontend/src/routes/dashboard/+page.svelte');
        $this->assertIsString($page);
        $this->assertStringContainsString('StatCard', $page);
        $this->assertStringContainsString('ChatGptUsageCard', $page);
        $this->assertStringContainsString('ClaudeUsageCard', $page);
        $this->assertStringNotContainsString('id="dashboardGrid"', $page);
        $this->assertStringNotContainsString('id="dashboardOpsStrip"', $page);
        $this->assertStringNotContainsString('id="dashboardFooter"', $page);
        $this->assertStringNotContainsString('chart.umd.min.js', $page);
        $this->assertStringNotContainsString('chartjs-plugin-zoom.min.js', $page);
    }

    public function testDashboardJsRendersTrendTilesInsteadOfChartJs(): void
    {
        // Sparkline is the SvelteKit inline-SVG replacement for Chart.js trend tiles.
        $sparkline = file_get_contents(__DIR__ . '/../frontend/src/lib/components/dashboard/Sparkline.svelte');
        $this->assertIsString($sparkline);
        $this->assertStringContainsString('function pathData(', $sparkline);
        $this->assertStringContainsString('<svg', $sparkline);
        $this->assertStringNotContainsString('renderDashboardGrid', $sparkline);
        $this->assertStringNotContainsString('refreshDashboardCharts', $sparkline);
        $this->assertStringNotContainsString('dashboardQuotaChart', $sparkline);
        $this->assertStringNotContainsString('dashboardCostChart', $sparkline);
        $this->assertStringNotContainsString('new window.Chart', $sparkline);
        $this->assertStringNotContainsString('Export CSV', $sparkline);
        $this->assertStringNotContainsString('dashboardCompareBtn', $sparkline);
        $this->assertStringNotContainsString('dashboardTypeBtn', $sparkline);
    }

    public function testDashboardJsKeepsLiveDebounceConstant(): void
    {
        // The WS client uses exponential back-off with defined min/max constants.
        $wsClient = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/client.ts');
        $this->assertIsString($wsClient);
        $this->assertStringContainsString('RECONNECT_MIN_MS', $wsClient);
        $this->assertStringContainsString('RECONNECT_MAX_MS', $wsClient);
        $this->assertStringContainsString('function backoffMs(', $wsClient);
    }

    public function testDashboardJsSupportsNewStructuredNavigationShortcuts(): void
    {
        // The SvelteKit nav registry lists all routes + the layout wires global shortcuts.
        $nav = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        $this->assertIsString($nav);
        $this->assertStringContainsString('href: "/hosts"', $nav);
        $this->assertStringContainsString('href: "/settings"', $nav);
        $this->assertStringContainsString('href: "/logs/api"', $nav);

        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        $this->assertStringContainsString('bindGlobalShortcuts', $layout);

        $shortcuts = file_get_contents(__DIR__ . '/../frontend/src/lib/utils/shortcuts.ts');
        $this->assertIsString($shortcuts);
        $this->assertStringContainsString('function bindGlobalShortcuts(', $shortcuts);
        $this->assertStringContainsString('isTypingInField', $shortcuts);
    }
}
