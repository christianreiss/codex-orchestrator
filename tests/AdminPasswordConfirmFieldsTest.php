<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasswordConfirmFieldsTest extends TestCase
{
    public function testLoginAndUserPasswordFieldsExist(): void
    {
        $userForm = file_get_contents(__DIR__ . '/../frontend/src/lib/components/users/UserFormDialog.svelte');
        $this->assertIsString($userForm);
        $this->assertStringContainsString('id="user-password-confirm"', $userForm);

        $login = file_get_contents(__DIR__ . '/../frontend/src/routes/login/+page.svelte');
        $this->assertIsString($login);
        $this->assertStringContainsString('id="password"', $login);
        $this->assertStringContainsString('type="password"', $login);
    }
}
