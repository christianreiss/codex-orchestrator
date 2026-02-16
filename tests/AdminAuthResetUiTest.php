<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAuthResetUiTest extends TestCase
{
    public function testDashboardNoLongerContainsAuthOverlayOrResetModal(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringNotContainsString('id="adminAuthOverlay"', $html);
        $this->assertStringNotContainsString('id="adminResetModal"', $html);
        $this->assertStringNotContainsString('id="adminAuthForgot"', $html);
    }

    public function testDedicatedLoginPageContainsLoginForm(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/login.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="adminLoginForm"', $html);
        $this->assertStringContainsString('id="adminLoginUsername"', $html);
        $this->assertStringContainsString('id="adminLoginPassword"', $html);
    }
}
