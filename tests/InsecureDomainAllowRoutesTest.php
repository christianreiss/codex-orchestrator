<?php

use PHPUnit\Framework\TestCase;

final class InsecureDomainAllowRoutesTest extends TestCase
{
    public function testAllowDomainApprovalRouteIsRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/insecure-approvals/(\\d+)/allow-domain$#",
            $routerSource,
            'Expected /admin/insecure-approvals/{id}/allow-domain route to exist in public/index.php'
        );
    }

    public function testDomainRevokeRouteIsRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/insecure-domain-allows/(\\d+)/revoke$#",
            $routerSource,
            'Expected /admin/insecure-domain-allows/{id}/revoke route to exist in public/index.php'
        );
    }
}
