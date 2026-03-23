<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class HostLanePreferenceEndpointTest extends TestCase
{
    public function testHostLaneRoutesAreRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertGreaterThanOrEqual(
            2,
            substr_count($routerSource, "#^/host/lane$#"),
            'Expected GET and POST /host/lane routes in public/index.php'
        );
    }

    public function testHostLaneRouteEnforcesValidationAndInsecureWindowChecks(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/HostApiController.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("lane must be one of: normal, spark, or null", $routerSource);
        self::assertStringContainsString("enforceInsecureWindow(\$host, 'host_lane_set')", $routerSource);
        self::assertStringContainsString('updateLanePreference(', $routerSource);
        self::assertStringContainsString("'host.lane.set'", $routerSource);
    }
}

