<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminLoginRouteDispatchTest extends TestCase
{
    public function testAdminIndexDispatchesDedicatedLoginRouteAndRedirects(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/admin/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("\$normalizedPath === '/admin/login'", $source);
        $this->assertStringContainsString("redirectTo('/admin/login')", $source);
        $this->assertStringContainsString("redirectTo('/admin/')", $source);
        $this->assertStringContainsString("__DIR__ . '/login.html'", $source);
        $this->assertStringContainsString("X-Admin-Page", $source);
    }
}
