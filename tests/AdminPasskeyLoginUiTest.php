<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyLoginUiTest extends TestCase
{
    public function testPasskeyLoginUsesUsernameBoundOptionsRequest(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/passkey-login.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("document.getElementById('adminLoginUsername')", $js);
        $this->assertStringContainsString("Enter your username to use passkey login.", $js);
        $this->assertStringContainsString("json: { username }", $js);
        $this->assertStringContainsString("/admin/auth/passkey/login/options", $js);
    }

    public function testPasskeyPanelCopyReflectsUsernameBoundLogin(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('login page uses your username before prompting for the passkey', $html);
    }
}
