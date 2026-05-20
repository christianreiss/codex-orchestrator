<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * The dashboard must subscribe to live ChatGPT-usage WebSocket events so the
 * quota meters update without a full page reload.
 *
 * Checks SvelteKit source files under frontend/src/ instead of the compiled
 * public/admin/assets/dashboard.js bundle.
 */
final class AdminChatGptUsageLiveUpdateTest extends TestCase
{
    public function testDashboardListensForChatGptUsageEvents(): void
    {
        // The WS invalidation map is the single source of truth for which events
        // trigger re-fetches. It must reference chatgpt.usage.updated so the
        // ChatGptUsageCard re-renders whenever the backend pushes a refresh.
        $events = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        self::assertIsString($events);

        $this->assertStringContainsString('chatgpt.usage.updated', $events);
        $this->assertStringContainsString('usage.refreshed', $events);

        // The ChatGPT usage card must expose a manual-refresh action.
        $card = file_get_contents(__DIR__ . '/../frontend/src/routes/dashboard/ChatGptUsageCard.svelte');
        self::assertIsString($card);

        $this->assertStringContainsString('chatgptRefreshMutation', $card);
        $this->assertStringContainsString('handleRefresh', $card);

        // The usage API module must wire into the query-client invalidation so
        // in-flight mutations and WS events both clear the stale cache.
        $usageApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/usage.ts');
        self::assertIsString($usageApi);

        $this->assertStringContainsString('chatgpt/usage/refresh', $usageApi);
        $this->assertStringContainsString('invalidateQueries', $usageApi);
    }
}
