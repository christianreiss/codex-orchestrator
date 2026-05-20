<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminHostDetailPageRoutingTest extends TestCase
{
    public function testApiFrontControllerDispatchesDedicatedHostDetailPath(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminPageController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/hosts/(\\d+)\$#", $source);
        $this->assertStringContainsString("#^/admin/hosts/(\\d+)/detail\$#", $source);
        $this->assertStringContainsString("/admin/index.php", $source);
    }

    public function testAdminDashboardUsesDedicatedHostDetailPanelWithoutModal(): void
    {
        // The SvelteKit host detail page is a dedicated route, not a modal.
        $hostDetailPage = file_get_contents(__DIR__ . '/../frontend/src/routes/hosts/[id]/+page.svelte');
        $this->assertIsString($hostDetailPage);

        // The page must show host stats, action items, technical context, and controls.
        $this->assertStringContainsString('Stats', $hostDetailPage);
        $this->assertStringContainsString('Action items', $hostDetailPage);
        $this->assertStringContainsString('Technical context', $hostDetailPage);
        $this->assertStringContainsString('Controls', $hostDetailPage);

        // No old-style detail modal — host detail lives on its own route.
        $this->assertStringNotContainsString('id="hostDetailModal"', $hostDetailPage);
    }

    public function testDashboardJsRoutesHostRowsToDedicatedPath(): void
    {
        // SvelteKit uses file-based routing and the goto() API for navigation.
        $hostsTable = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/HostsTable.svelte');
        $this->assertIsString($hostsTable);

        // Clicking a row navigates to the dedicated host detail route.
        $this->assertStringContainsString('openHost', $hostsTable);
        $this->assertStringContainsString('goto', $hostsTable);
        $this->assertStringContainsString('/hosts/${h.id}', $hostsTable);

        // The host detail page fetches host data from the /detail API endpoint.
        $hostsApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/hosts.ts');
        $this->assertIsString($hostsApi);

        $this->assertStringContainsString('hostDetailQuery', $hostsApi);
        $this->assertStringContainsString('/admin/hosts/${id}/detail', $hostsApi);

        // The host detail page handles the "Clear auth" action.
        $hostDetailPage = file_get_contents(__DIR__ . '/../frontend/src/routes/hosts/[id]/+page.svelte');
        $this->assertIsString($hostDetailPage);

        $this->assertStringContainsString('clearAuth', $hostDetailPage);
        $this->assertStringContainsString('Clear auth', $hostDetailPage);
    }

    public function testDashboardJsIgnoresInlineControlsWhenOpeningHostDetail(): void
    {
        // SvelteKit hosts table uses event.stopPropagation() on inline controls so
        // clicking a toggle / switch does not navigate to the host detail page.
        $hostsTable = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/HostsTable.svelte');
        $this->assertIsString($hostsTable);

        $this->assertStringContainsString('stopPropagation', $hostsTable);
        $this->assertStringContainsString('onToggleAutoUpdate', $hostsTable);
    }
}
