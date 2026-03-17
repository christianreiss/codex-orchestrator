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
            "#^/admin/hosts/(\\\\d+)/auto-update$#",
            $routerSource,
            'Expected /admin/hosts/{id}/auto-update route to exist in public/index.php'
        );
    }

    public function testHostListIncludesAutoUpdateOverrideField(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        $needle = "\$router->add('GET', '#^/admin/hosts$#'";
        $start = strpos($routerSource, $needle);
        self::assertNotFalse($start, 'Expected to find /admin/hosts route definition');

        $responsePos = strpos($routerSource, 'Response::json', $start);
        self::assertNotFalse($responsePos, 'Expected /admin/hosts to return JSON');

        $end = strpos($routerSource, "});", $responsePos);
        self::assertNotFalse($end, 'Expected to find end of /admin/hosts route');

        $routeBlock = substr($routerSource, $start, $end - $start);

        self::assertStringContainsString(
            "'auto_update_override'",
            $routeBlock,
            'Expected /admin/hosts to include auto_update_override so dashboard toggles persist after reload'
        );
    }
}
