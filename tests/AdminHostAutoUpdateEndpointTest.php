<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminHostAutoUpdateEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\d+)/auto-update$#",
            $routerSource,
            'Expected /admin/hosts/{id}/auto-update route to exist in public/index.php'
        );
    }

    public function testHostListIncludesAutoUpdateOverrideField(): void
    {
        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString(
            "'auto_update_override'",
            $controllerSource,
            'Expected /admin/hosts to include auto_update_override so dashboard toggles persist after reload'
        );
        self::assertStringContainsString(
            "'last_cron_check'",
            $controllerSource,
            'Expected /admin/hosts to include last_cron_check so the dashboard can show recent cron auto-update check-ins'
        );
    }
}
