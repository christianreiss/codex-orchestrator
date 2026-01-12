<?php

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsDisableAllEndpointTest extends TestCase
{
    public function testDisableAllEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/insecure/disable-all$#",
            $routerSource,
            'Expected /admin/hosts/insecure/disable-all route to exist in public/index.php'
        );
    }
}
