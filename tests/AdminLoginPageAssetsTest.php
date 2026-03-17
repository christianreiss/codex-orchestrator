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
        $this->assertStringContainsString('/admin/assets/login.css?v=', $html);
        $this->assertStringContainsString('/admin/assets/login.js?v=', $html);
        $this->assertStringContainsString('/admin/assets/passkey-login.js?v=', $html);
        $this->assertStringContainsString('id="adminLoginError"', $html);
    }
}
