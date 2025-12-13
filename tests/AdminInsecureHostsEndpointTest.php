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
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        $needle = "\$router->add('GET', '#^/admin/hosts/insecure$#'";
        $start = strpos($routerSource, $needle);
        self::assertNotFalse($start, 'Expected to find /admin/hosts/insecure route definition');

        $responsePos = strpos($routerSource, 'Response::json', $start);
        self::assertNotFalse($responsePos, 'Expected /admin/hosts/insecure to return JSON');

        $end = strpos($routerSource, "});", $responsePos);
        self::assertNotFalse($end, 'Expected to find end of /admin/hosts/insecure route');

        $routeBlock = substr($routerSource, $start, $end - $start);

        self::assertStringContainsString(
            'format(DATE_ATOM)',
            $routeBlock,
            'Expected /admin/hosts/insecure to normalize insecure_enabled_until using DATE_ATOM (timezone-aware)'
        );
    }
}
