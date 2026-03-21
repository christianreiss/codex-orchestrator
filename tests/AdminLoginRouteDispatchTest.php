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
        $this->assertStringContainsString('renderAdminErrorPage(', $source);
        $this->assertStringContainsString('Client certificate required', $source);
        $this->assertStringContainsString('/admin/assets/theme.css?v=', $source);
    }

    public function testApiFrontControllerDispatchesAdminLoginAndAdminRoot(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $helpers = file_get_contents(__DIR__ . '/../src/Http/helpers.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("\$router->add('GET', '#^/admin/?\$#', function (): void {", $source);
        $this->assertStringContainsString("\$router->add('GET', '#^/admin/login\$#', function (): void {", $source);
        $this->assertStringContainsString("\$router->add('POST', '#^/admin/auth/login/method\$#', function () use (\$payload, \$adminAuthService) {", $source);
        $this->assertStringContainsString("'/admin/auth/login/method'", $source . $helpers);
        $this->assertStringContainsString("require __DIR__ . '/admin/index.php';", $source);
    }
}
