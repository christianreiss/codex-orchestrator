<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * After the Spark Lane removal, the dashboard renders only the Normal lane.
 * Backend still tracks Spark fields, but the UI never surfaces them.
 */
final class AdminChatGptUsageDualLaneTest extends TestCase
{
    public function testDashboardRendersOnlyNormalLane(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("function renderChatGptUsage(usage) {", $js);
        $this->assertStringContainsString("{ label: '5-hour runway', data: normalPrimary, windowKey: 'normal:primary' }", $js);
        $this->assertStringContainsString("{ label: 'Weekly runway', data: normalSecondary, windowKey: 'normal:secondary' }", $js);
        $this->assertStringContainsString('class="usage-card-head"', $js);
        $this->assertStringContainsString('class="usage-plan-pill"', $js);
        $this->assertStringContainsString('class="usage-lanes"', $js);
    }

    public function testDashboardHasNoSparkLaneSurface(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringNotContainsString('renderUsageLaneCard', $js);
        $this->assertStringNotContainsString('hasSpark', $js);
        $this->assertStringNotContainsString("title: 'Spark'", $js);
        $this->assertStringNotContainsString("title: 'Normal'", $js);
        $this->assertStringNotContainsString('sparkPrimary', $js);
        $this->assertStringNotContainsString('sparkSecondary', $js);
        $this->assertStringNotContainsString("data-lane=\"spark\"", $js);
        $this->assertStringNotContainsString('usage-cockpit', $js);
        $this->assertStringNotContainsString('usage-stage', $js);
        $this->assertStringNotContainsString('Burst lane', $js);
    }

    public function testDashboardCssMatchesNewLaneCardLayout(): void
    {
        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('#chatgpt-usage-card', $css);
        $this->assertStringContainsString('#claude-usage-card', $css);
        $this->assertStringContainsString('.usage-card-head', $css);
        $this->assertStringContainsString('.usage-plan-pill', $css);
        $this->assertStringNotContainsString('.usage-cockpit', $css);
        $this->assertStringNotContainsString('.usage-stage', $css);
    }
}
