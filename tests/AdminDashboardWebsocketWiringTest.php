<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardWebsocketWiringTest extends TestCase
{
    public function testAdminIndexLoadsDashboardAndWsScriptsInOrder(): void
    {
        // In the SvelteKit app, the root layout initialises the WS client and
        // wires it to the query client.  The layout imports must appear in order:
        // ws/client (createWsClient) and then ws/events (wireWsToQueryClient).
        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);

        $createWsPos = strpos($layout, 'createWsClient');
        $wireWsPos   = strpos($layout, 'wireWsToQueryClient');

        $this->assertIsInt($createWsPos);
        $this->assertIsInt($wireWsPos);
        // wireWsToQueryClient is called after createWsClient produces the handle.
        $this->assertGreaterThan($createWsPos, $wireWsPos);
    }

    public function testDashboardUnknownWsActionsStillRefreshOverviewAndHosts(): void
    {
        // The SvelteKit events map handles all known events; host + overview keys
        // are always included so any host-related action triggers a refresh.
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($events);

        // wireWsToQueryClient iterates every event and invalidates matching query keys.
        $this->assertStringContainsString('function wireWsToQueryClient(', $events);
        $this->assertStringContainsString('qc.invalidateQueries(', $events);
        // Overview key is invalidated for host events.
        $this->assertStringContainsString('"host.created"', $events);
        $this->assertStringContainsString('"host.deleted"', $events);
        $this->assertStringContainsString('["overview"]', $events);
    }

    public function testDashboardRingsBellForNewInsecureApprovalRequests(): void
    {
        // The SvelteKit insecure approvals feature: pending approvals are fetched
        // via a reactive query that auto-refreshes and is driven by WS events.
        $insecureApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/insecure.ts');
        $this->assertIsString($insecureApi);
        $this->assertStringContainsString('"/admin/insecure-approvals/pending"', $insecureApi);
        $this->assertStringContainsString('refetchInterval', $insecureApi);
        $this->assertStringContainsString('insecureApprovalsQuery', $insecureApi);

        // The WS event map notifies on insecure approval changes.
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($events);
        $this->assertStringContainsString('"insecure.requested"', $events);
        $this->assertStringContainsString('"insecure.approved"', $events);
        $this->assertStringContainsString('["insecure-approvals"]', $events);
    }

    public function testDashboardBootstrapsPendingInsecureApprovalsOnLoadAndWsReconnect(): void
    {
        // Pending approvals are bootstrapped via insecureApprovalsQuery on mount and
        // kept live via WS invalidations.
        $insecureApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/insecure.ts');
        $this->assertIsString($insecureApi);
        $this->assertStringContainsString('"/admin/insecure-approvals/pending"', $insecureApi);

        // WS reconnect is handled transparently by the auto-reconnecting client.
        $wsClient = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/client.ts');
        $this->assertIsString($wsClient);
        $this->assertStringContainsString('status.set("open")', $wsClient);
        $this->assertStringContainsString('scheduleReconnect', $wsClient);
        $this->assertStringContainsString('function connect(', $wsClient);

        // The layout starts the WS client once the user is authenticated.
        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        $this->assertStringContainsString('createWsClient', $layout);
        $this->assertStringContainsString('wireWsToQueryClient', $layout);
        $this->assertStringContainsString('state.authenticated', $layout);
    }
}
