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

        // Login-route detection and redirect logic.
        $this->assertStringContainsString("\$normalizedPath === '/admin/login'", $source);
        $this->assertStringContainsString("redirectTo('/admin/login')", $source);
        $this->assertStringContainsString("redirectTo('/admin/')", $source);

        // The SvelteKit SPA uses a single index.html shell for all admin routes.
        $this->assertStringContainsString("__DIR__ . '/index.html'", $source);

        // Error page and mTLS gate remain in place.
        $this->assertStringContainsString("X-Admin-Page", $source);
        $this->assertStringContainsString('renderAdminErrorPage(', $source);
        $this->assertStringContainsString('Client certificate required', $source);

        // Bootstrap injection for the SvelteKit auth store.
        $this->assertStringContainsString('window.__adminBootstrap =', $source);
    }

    public function testApiFrontControllerDispatchesAdminLoginAndAdminRoot(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminPageController.php');
        $helpers = file_get_contents(__DIR__ . '/../src/Http/helpers.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/?\$#", $source);
        $this->assertStringContainsString("#^/admin/login\$#", $source);
        $this->assertStringContainsString("#^/admin/auth/login/method\$#", $source);
        $adminSessionHelper = file_get_contents(__DIR__ . '/../src/Http/AdminSessionHelper.php');
        $this->assertStringContainsString("'/admin/auth/login/method'", $source . $helpers . $adminSessionHelper);
        $this->assertStringContainsString("/admin/index.php", $source);
    }
}
