<?php

use PHPUnit\Framework\TestCase;

final class AdminPrunePolicyEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/prune-policy$#",
            $routerSource,
            'Expected /admin/prune-policy route to exist in public/index.php'
        );
    }

    public function testOverviewIncludesInactivityWindowDays(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("'inactivity_window_days'", $routerSource);
    }
}

