<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardOverviewLiveUpdateTest extends TestCase
{
    public function testDashboardRefreshesOverviewOnWebsocketEvents(): void
    {
        // The SvelteKit WS invalidation map drives live data refreshes.
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($events);

        // Host events invalidate the overview query key.
        $this->assertStringContainsString('"host.updated"', $events);
        $this->assertStringContainsString('["overview"]', $events);
        $this->assertStringContainsString('["hosts"]', $events);

        // Usage / dashboard events.
        $this->assertStringContainsString('"usage.refreshed"', $events);
        $this->assertStringContainsString('["dashboard"]', $events);

        // Per-model usage events.
        $this->assertStringContainsString('"chatgpt.usage.updated"', $events);
        $this->assertStringContainsString('"claude.usage.updated"', $events);
        $this->assertStringContainsString('["usage", "chatgpt"]', $events);
        $this->assertStringContainsString('["usage", "claude"]', $events);

        // Settings live refresh.
        $this->assertStringContainsString('"settings.changed"', $events);
        $this->assertStringContainsString('["settings"]', $events);

        // Insecure approval events trigger overview + approvals refresh.
        $this->assertStringContainsString('"insecure.approval.changed"', $events);
        $this->assertStringContainsString('["insecure-approvals"]', $events);

        // The map is wired to the query client in the layout.
        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        $this->assertStringContainsString('wireWsToQueryClient', $layout);
        $this->assertStringContainsString('createWsClient', $layout);
    }
}
