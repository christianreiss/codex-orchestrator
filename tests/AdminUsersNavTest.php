<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersNavTest extends TestCase
{
    public function testUsersNavLinkExists(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        $this->assertIsString($src);

        $this->assertStringContainsString('href: "/users"', $src);
        $this->assertStringContainsString('label: "Users"', $src);
    }

    public function testUsersPanelExists(): void
    {
        $this->assertFileExists(__DIR__ . '/../frontend/src/routes/users/+page.svelte');

        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/users/+page.svelte');
        $this->assertIsString($src);
        $this->assertStringContainsString('UsersTable', $src);
    }

    public function testUsersSettingsPanelIsNotTopLevelHidden(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        $this->assertIsString($src);

        // In SvelteKit routing, all routes are first-class — no hidden panel IDs.
        // Verify the users route is registered in the top-level nav array.
        $this->assertStringContainsString('href: "/users"', $src);
        $this->assertStringNotContainsString('hidden', $src);
    }
}
