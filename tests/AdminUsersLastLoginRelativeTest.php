<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersLastLoginRelativeTest extends TestCase
{
    public function testLastLoginRelativeMarkupPresent(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/components/users/UsersTable.svelte');
        $this->assertIsString($src);

        $this->assertStringContainsString('last_login_at', $src);
        $this->assertStringContainsString('relativeTime', $src);
    }
}
