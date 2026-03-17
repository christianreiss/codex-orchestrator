<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyLoginUiTest extends TestCase
{
    public function testLoginPageUsesUsernameStageBeforePasskeyOrPassword(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/login.js');
        $this->assertIsString($js);
        $auth = file_get_contents(__DIR__ . '/../src/Services/AdminAuthService.php');
        $this->assertIsString($auth);

        $this->assertStringContainsString("/admin/auth/login/method", $js);
        $this->assertStringContainsString("Enter your username to continue.", $js);
        $this->assertStringContainsString("json: { username }", $js);
        $this->assertStringContainsString("/admin/auth/passkey/login/options", $js);
        $this->assertStringContainsString('Passkey login required for this user', $auth);
    }

    public function testPasskeyPanelCopyReflectsPasskeyOnlyLoginForPasskeyUsers(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('users with a registered passkey must sign in with that passkey', $html);
    }
}
