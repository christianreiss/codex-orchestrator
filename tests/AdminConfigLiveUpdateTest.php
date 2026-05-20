<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminConfigLiveUpdateTest extends TestCase
{
    /**
     * The SvelteKit frontend uses a WebSocket event-to-query invalidation map
     * (lib/ws/events.ts) instead of the old config.js push-refresh handler.
     * Verify that settings changes received over the WebSocket trigger a
     * live re-fetch of the settings queries.
     */
    public function testConfigBuilderListensForPushRefreshEvents(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($src);

        // The WS event map must handle the settings.changed event.
        $this->assertStringContainsString('"settings.changed"', $src,
            "ws/events.ts must handle the 'settings.changed' WebSocket event.");

        // It must invalidate the ['settings'] query key so the settings page
        // re-fetches live data when the server broadcasts a change.
        $this->assertStringContainsString('["settings"]', $src,
            "ws/events.ts must invalidate the ['settings'] query key on settings.changed.");

        // The invalidation wiring function must exist.
        $this->assertStringContainsString('wireWsToQueryClient', $src,
            'ws/events.ts must export the wireWsToQueryClient function.');

        // The subscription must call invalidateQueries to propagate remote updates.
        $this->assertStringContainsString('invalidateQueries', $src,
            'wireWsToQueryClient must call invalidateQueries to refresh stale data.');
    }
}
