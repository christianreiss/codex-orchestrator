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

        $this->assertStringContainsString('data-settings-tab="users"', $html);
        $this->assertStringContainsString('href="/admin/settings/users"', $html);
        $this->assertStringContainsString('>Users<', $html);
    }

    public function testUsersPanelExists(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-panel="users"', $html);
        $this->assertStringContainsString('id="users-panel"', $html);
    }

    public function testUsersSettingsPanelIsNotTopLevelHidden(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $matched = preg_match('/const allIds = \[(?<ids>[^\]]+)\];/', $js, $matches);
        $this->assertSame(1, $matched);
        $this->assertStringNotContainsString("'users-panel'", $matches['ids']);
    }
}
