<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavUserNameTest extends TestCase
{
    public function testUpperRightAccountMenuHooksExist(): void
    {
        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        $this->assertIsString($sidebar);

        // User avatar initial is derived from name or username
        $this->assertStringContainsString('auth.user.name', $sidebar);
        $this->assertStringContainsString('auth.user.username', $sidebar);
        // Account dropdown exposes password + passkeys links
        $this->assertStringContainsString('/account/password', $sidebar);
        $this->assertStringContainsString('/account/passkeys', $sidebar);
        // Sign-out action is wired in the dropdown
        $this->assertStringContainsString('signOut', $sidebar);
        // Role/label shown beneath user name
        $this->assertStringContainsString('auth.roles', $sidebar);
        // Authenticated guard before rendering the account menu
        $this->assertStringContainsString('auth.authenticated', $sidebar);

        $authStore = file_get_contents(__DIR__ . '/../frontend/src/lib/stores/auth.ts');
        $this->assertIsString($authStore);
        // Bootstrap is read from window.__adminBootstrap
        $this->assertStringContainsString('window.__adminBootstrap', $authStore);
        // Auth store provides user and roles
        $this->assertStringContainsString('user:', $authStore);
        $this->assertStringContainsString('roles:', $authStore);
        // Logout posts to the admin auth endpoint
        $this->assertStringContainsString('/admin/auth/logout', $authStore);
        // Credentials follow same-origin policy via the shared API client
        $api = file_get_contents(__DIR__ . '/../frontend/src/lib/api/client.ts');
        $this->assertIsString($api);
        $this->assertStringContainsString('credentials', $api);
    }
}
