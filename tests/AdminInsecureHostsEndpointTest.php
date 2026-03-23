<?php

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/insecure$#",
            $routerSource,
            'Expected /admin/hosts/insecure route to exist in public/index.php'
        );
    }

    public function testEndpointReturnsTimezoneAwareEnabledUntil(): void
    {
        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString(
            'format(DATE_ATOM)',
            $controllerSource,
            'Expected /admin/hosts/insecure to normalize insecure_enabled_until using DATE_ATOM (timezone-aware)'
        );

        self::assertStringContainsString(
            'if (!$isActive) {',
            $controllerSource,
            'Expected /admin/hosts/insecure to filter out inactive hosts/domains before returning them'
        );
        self::assertStringContainsString(
            "'count' => count(\$items)",
            $controllerSource,
            'Expected /admin/hosts/insecure count to reflect the filtered host list'
        );
    }
}
