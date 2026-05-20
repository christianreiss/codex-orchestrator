<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminAuthBootstrapTest extends TestCase
{
    public function testAdminShellBootstrapsAuthStateFromServerSession(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/admin/index.php');
        $this->assertIsString($source);

        // The PHP gateway injects a bootstrap payload into the SvelteKit shell.
        $this->assertStringContainsString("window.__adminBootstrap =", $source);
        $this->assertStringContainsString("json_encode(\$bootstrap", $source);

        // The bootstrap object must carry enforced, authenticated, and user keys.
        $this->assertStringContainsString("'enforced'", $source);
        $this->assertStringContainsString("'authenticated'", $source);
        $this->assertStringContainsString("'user'", $source);

        // The SvelteKit auth store reads the bootstrap from window.__adminBootstrap.
        $authStore = file_get_contents(__DIR__ . '/../frontend/src/lib/stores/auth.ts');
        $this->assertIsString($authStore);
        $this->assertStringContainsString("window.__adminBootstrap", $authStore);
        $this->assertStringContainsString("applyBootstrap", $authStore);
    }
}
