<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersNavTest extends TestCase
{
    public function testUsersNavLinkExists(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-nav="users"', $html);
        $this->assertStringContainsString('href="/admin/users"', $html);
        $this->assertStringContainsString('>Users<', $html);
    }

    public function testUsersPanelExists(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-panel="users"', $html);
        $this->assertStringContainsString('id="users-panel"', $html);
    }
}
