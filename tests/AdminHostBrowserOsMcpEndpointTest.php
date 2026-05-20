<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminHostBrowserOsMcpEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\d+)/browseros-mcp$#",
            $routerSource,
            'Expected /admin/hosts/{id}/browseros-mcp route to exist in public/index.php'
        );
    }

    public function testHostListIncludesBrowserOsMcpField(): void
    {
        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString("'browseros_mcp_enabled'", $controllerSource);
    }
}
