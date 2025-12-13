<?php

use PHPUnit\Framework\TestCase;

final class AdminCodexVersionEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/codex-version$#",
            $routerSource,
            'Expected /admin/codex-version route to exist in public/index.php'
        );
    }

    public function testOverviewIncludesClientVersionLockFields(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("'client_version_lock'", $routerSource);
        self::assertStringContainsString("'client_version_lock_updated_at'", $routerSource);
    }
}

