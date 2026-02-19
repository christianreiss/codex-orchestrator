<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersLiveUpdateTest extends TestCase
{
    public function testUsersPanelListensForPushRefreshEvents(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/users.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('admin-data-dirty', $js);
        $this->assertStringContainsString("domains.includes('users')", $js);
        $this->assertStringContainsString('scheduleLiveUsersRefresh', $js);
    }
}
