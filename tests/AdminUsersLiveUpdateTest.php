<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersLiveUpdateTest extends TestCase
{
    public function testUsersPanelListensForPushRefreshEvents(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/ws/events.ts');
        $this->assertIsString($src);

        $this->assertStringContainsString('"user.updated"', $src);
        $this->assertStringContainsString('"user.created"', $src);
        $this->assertStringContainsString('"user.deleted"', $src);
        $this->assertStringContainsString('["users"]', $src);
    }
}
