<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminProfilesLiveUpdateTest extends TestCase
{
    public function testProfilesPanelListensForPushRefreshEvents(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($src);

        // Authoring (skills/agents/memories) live updates are driven by WS event invalidations.
        $this->assertStringContainsString('"skill.updated"', $src);
        $this->assertStringContainsString('"skill.stored"', $src);
        $this->assertStringContainsString('"agents.stored"', $src);
        $this->assertStringContainsString('["authoring"', $src);
    }
}
