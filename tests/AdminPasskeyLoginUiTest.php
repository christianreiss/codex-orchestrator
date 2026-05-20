<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyLoginUiTest extends TestCase
{
    public function testLoginPageUsesUsernameStageBeforePasskeyOrPassword(): void
    {
        $svelte = file_get_contents(__DIR__ . '/../frontend/src/routes/login/+page.svelte');
        $this->assertIsString($svelte);
        $auth = file_get_contents(__DIR__ . '/../src/Services/AdminAuthService.php');
        $this->assertIsString($auth);

        $this->assertStringContainsString('/admin/auth/login/method', $svelte);
        $this->assertStringContainsString('Enter your username', $svelte);
        $this->assertStringContainsString('username: username.trim()', $svelte);
        $this->assertStringContainsString('/admin/auth/passkey/login/options', $svelte);
        $this->assertStringContainsString('Passkey login required for this user', $auth);
    }

    public function testPasskeyPanelCopyReflectsPasskeyOnlyLoginForPasskeyUsers(): void
    {
        $svelte = file_get_contents(__DIR__ . '/../frontend/src/routes/account/passkeys/+page.svelte');
        $this->assertIsString($svelte);
        $this->assertStringContainsString('users with a registered passkey must sign in with that passkey', $svelte);
    }
}
