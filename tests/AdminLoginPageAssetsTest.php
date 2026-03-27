<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminLoginPageAssetsTest extends TestCase
{
    public function testLoginPageLoadsDedicatedAssets(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/login.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('rel="prefetch" href="/admin/index.html" as="document" data-admin-prefetch', $html);
        $this->assertStringContainsString('/admin/assets/dashboard.css?v=2026-03-27-02', $html);
        $this->assertStringContainsString('/admin/assets/dashboard-mobile.css?v=2026-03-27-02', $html);
        $this->assertStringContainsString('/admin/assets/dashboard.js?v=2026-03-27-03', $html);
        $this->assertStringContainsString('/admin/assets/theme.css?v=', $html);
        $this->assertStringContainsString('/admin/assets/login.css?v=', $html);
        $this->assertStringContainsString('/admin/assets/login.js?v=', $html);
        $this->assertStringNotContainsString('/admin/assets/passkey-login.js?v=', $html);
        $this->assertStringContainsString('id="adminLoginError"', $html);
    }

    public function testLoginScriptWarmsAdminShellInBackground(): void
    {
        $script = file_get_contents(__DIR__ . '/../public/admin/assets/login.js');
        $this->assertIsString($script);
        $this->assertStringContainsString('function warmAdminShell()', $script);
        $this->assertStringContainsString("document.querySelectorAll('link[data-admin-prefetch][href]')", $script);
        $this->assertStringContainsString("cache: 'force-cache'", $script);
        $this->assertStringContainsString('scheduleAdminShellWarmup();', $script);
    }

    public function testDashboardLoadsSharedThemeAssetWithoutRemoteFonts(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('/admin/assets/theme.css?v=', $html);
        $this->assertStringNotContainsString('fonts.googleapis.com', $html);
        $this->assertStringNotContainsString('fonts.gstatic.com', $html);
    }
}
