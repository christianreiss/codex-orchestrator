<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminToastEndpointTest extends TestCase
{
    public function testToastEndpointIsRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($routerSource);

        $this->assertStringContainsString(
            "#^/admin/toasts$#",
            $routerSource,
            'Expected /admin/toasts route to exist in public/index.php'
        );
    }
}
