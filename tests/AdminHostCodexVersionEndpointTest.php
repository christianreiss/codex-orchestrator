<?php

use PHPUnit\Framework\TestCase;

final class AdminHostCodexVersionEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\\\d+)/codex-version$#",
            $routerSource,
            'Expected /admin/hosts/{id}/codex-version route to exist in public/index.php'
        );
    }

    public function testHostListIncludesClientVersionOverrideField(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("'client_version_override'", $routerSource);
    }
}

