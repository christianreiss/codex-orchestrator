<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * After the Spark Lane removal, the dashboard renders only the Normal lane.
 * Backend still tracks Spark fields, but the UI never surfaces them.
 *
 * Checks SvelteKit source files under frontend/src/ instead of the compiled
 * public/admin/assets/dashboard.js bundle.
 */
final class AdminChatGptUsageDualLaneTest extends TestCase
{
    private function chatGptCard(): string
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/dashboard/ChatGptUsageCard.svelte');
        self::assertIsString($src);
        return $src;
    }

    private function usageApi(): string
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/api/usage.ts');
        self::assertIsString($src);
        return $src;
    }

    public function testDashboardRendersOnlyNormalLane(): void
    {
        $src = $this->chatGptCard();

        // Card fetches usage via the chatgptUsageQuery helper.
        $this->assertStringContainsString('chatgptUsageQuery', $src);

        // The two usage meters map to the normal primary (5-hour) and secondary (weekly) windows.
        $this->assertStringContainsString('label="5-hour window"', $src);
        $this->assertStringContainsString('label="Weekly window"', $src);

        // Plan type is surfaced in the card description.
        $this->assertStringContainsString('planType', $src);

        // UsageMeter component is used for each lane.
        $this->assertStringContainsString('UsageMeter', $src);
    }

    public function testDashboardHasNoSparkLaneSurface(): void
    {
        $src = $this->chatGptCard();

        $this->assertStringNotContainsString('renderUsageLaneCard', $src);
        $this->assertStringNotContainsString('hasSpark', $src);
        $this->assertStringNotContainsString("'Spark'", $src);
        $this->assertStringNotContainsString("'Normal'", $src);
        $this->assertStringNotContainsString('sparkPrimary', $src);
        $this->assertStringNotContainsString('sparkSecondary', $src);
        $this->assertStringNotContainsString('data-lane="spark"', $src);
        $this->assertStringNotContainsString('usage-cockpit', $src);
        $this->assertStringNotContainsString('usage-stage', $src);
        $this->assertStringNotContainsString('Burst lane', $src);
    }

    public function testDashboardCssMatchesNewLaneCardLayout(): void
    {
        // The SvelteKit dashboard page embeds both usage cards directly.
        $page = file_get_contents(__DIR__ . '/../frontend/src/routes/dashboard/+page.svelte');
        self::assertIsString($page);

        // Both usage card components must be present in the dashboard.
        $this->assertStringContainsString('ChatGptUsageCard', $page);
        $this->assertStringContainsString('ClaudeUsageCard', $page);

        // The card component uses CardTitle / CardDescription from the UI library.
        $src = $this->chatGptCard();
        $this->assertStringContainsString('CardTitle', $src);
        $this->assertStringContainsString('CardDescription', $src);

        // No legacy two-cockpit layout classes anywhere in the component.
        $this->assertStringNotContainsString('usage-cockpit', $src);
        $this->assertStringNotContainsString('usage-stage', $src);
    }
}
