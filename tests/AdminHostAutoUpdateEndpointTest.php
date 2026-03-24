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
        self::assertStringContainsString("'auto_update_state'", $controllerSource);
        self::assertStringContainsString("'auto_update_label'", $controllerSource);
        self::assertStringContainsString("'auto_update_emoji'", $controllerSource);
        self::assertStringContainsString("'auto_update_rank'", $controllerSource);
    }

    public function testHostListDerivesDetailedAutoUpdateStates(): void
    {
        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString('disabled_but_cron_running', $controllerSource);
        self::assertStringContainsString('enabled_missing_checkin', $controllerSource);
        self::assertStringContainsString('enabled_update_succeeded', $controllerSource);
        self::assertStringContainsString('enabled_checked_before_new_release', $controllerSource);
        self::assertStringContainsString('enabled_checked_update_needed', $controllerSource);
        self::assertStringContainsString('enabled_current_checked', $controllerSource);
        self::assertStringContainsString('Checked in and auto-update succeeded', $controllerSource);
        self::assertStringContainsString('Expected daily cron check-in is missing', $controllerSource);
    }
}
