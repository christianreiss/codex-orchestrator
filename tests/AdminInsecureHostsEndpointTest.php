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
}

