<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardChartLibraryTest extends TestCase
{
    public function testDashboardDoesNotShipChartJs(): void
    {
        // The Sparkline component is an inline SVG – no Chart.js canvas required.
        $sparkline = file_get_contents(__DIR__ . '/../frontend/src/lib/components/dashboard/Sparkline.svelte');
        $this->assertIsString($sparkline);
        $this->assertStringNotContainsString('chart.umd.min.js', $sparkline);
        $this->assertStringNotContainsString('chartjs-plugin-zoom.min.js', $sparkline);
        $this->assertStringNotContainsString("from 'chart.js'", $sparkline);
        $this->assertStringNotContainsString('window.Chart', $sparkline);
    }

    public function testDashboardUsesInlineSvgSparklines(): void
    {
        $sparkline = file_get_contents(__DIR__ . '/../frontend/src/lib/components/dashboard/Sparkline.svelte');
        $this->assertIsString($sparkline);
        // Must render a real SVG element, not a Chart.js canvas.
        $this->assertStringContainsString('<svg', $sparkline);
        $this->assertStringContainsString('aria-label="trend sparkline"', $sparkline);
        // Paths are calculated via pure JS – no external chart library.
        $this->assertStringContainsString('function pathData(', $sparkline);
        $this->assertStringNotContainsString('window.Chart', $sparkline);
        $this->assertStringNotContainsString('refreshDashboardCharts', $sparkline);
    }

    public function testNavigationShowsShortcutHints(): void
    {
        // The SvelteKit sidebar renders nav items from NAV registry without chord shortcuts.
        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        $this->assertIsString($sidebar);
        // Sidebar renders labels from the NAV array.
        $this->assertStringContainsString('item.label', $sidebar);
        $this->assertStringContainsString('isActive', $sidebar);

        // The nav registry contains all expected top-level routes.
        $nav = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        $this->assertIsString($nav);
        $this->assertStringContainsString('href: "/hosts"', $nav);
        $this->assertStringContainsString('href: "/logs/api"', $nav);
        $this->assertStringContainsString('href: "/settings"', $nav);
        $this->assertStringContainsString('href: "/users"', $nav);
        $this->assertStringContainsString('label: "Dashboard"', $nav);

        // Global keyboard shortcut handler is wired in layout.
        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        $this->assertStringContainsString('bindGlobalShortcuts', $layout);
        $this->assertStringContainsString('"?"', $layout);
        $this->assertStringContainsString('codex:open-shortcuts', $layout);
    }

    public function testNewHostModalUsesHostnameCopyAndOptionGrid(): void
    {
        // NewHostSheet is the SvelteKit replacement for the old vanilla new-host-modal.
        $sheet = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/NewHostSheet.svelte');
        $this->assertIsString($sheet);
        // Must provide a hostname input.
        $this->assertStringContainsString('Hostname (FQDN)', $sheet);
        $this->assertStringContainsString("placeholder=\"vm42.example.org\"", $sheet);
        // Vibe option grid: Secure, Temporary, Insecure curl, VIP.
        $this->assertStringContainsString('"secure"', $sheet);
        $this->assertStringContainsString('"temporary"', $sheet);
        $this->assertStringContainsString('"insecure-curl"', $sheet);
        $this->assertStringContainsString('"vip"', $sheet);
        // Success stage: copy installer + delete accident + mint another.
        $this->assertStringContainsString('copyCommand', $sheet);
        $this->assertStringContainsString('deleteAccident', $sheet);
        $this->assertStringContainsString('mintAnother', $sheet);
        $this->assertStringContainsString('Copy', $sheet);
        $this->assertStringContainsString('Delete accident', $sheet);
        $this->assertStringContainsString('Mint another', $sheet);
        // Calls the quick-register endpoint.
        $this->assertStringContainsString('createRegisterHostMutation', $sheet);

        // QuickVmDialog handles the three engine combos (codex, claude, both).
        $quickVm = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/QuickVmDialog.svelte');
        $this->assertIsString($quickVm);
        $this->assertStringContainsString('spin(["codex"]', $quickVm);
        $this->assertStringContainsString('spin(["claude"]', $quickVm);
        $this->assertStringContainsString('spin(["codex", "claude"]', $quickVm);
        $this->assertStringContainsString('createQuickRegisterMutation', $quickVm);
        $this->assertStringContainsString('Codex only', $quickVm);
        $this->assertStringContainsString('Claude only', $quickVm);
        $this->assertStringContainsString('Both', $quickVm);

        // Hosts API wires up to /admin/hosts/quick-register.
        $hostsApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/hosts.ts');
        $this->assertIsString($hostsApi);
        $this->assertStringContainsString('"/admin/hosts/quick-register"', $hostsApi);
    }
}
