<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasswordConfirmFieldsTest extends TestCase
{
    public function testLoginAndUserPasswordFieldsExist(): void
    {
        $dashboard = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($dashboard);
        $this->assertStringContainsString('id="usersPasswordConfirm"', $dashboard);

        $login = file_get_contents(__DIR__ . '/../public/admin/login.html');
        $this->assertIsString($login);
        $this->assertStringContainsString('id="adminLoginPassword"', $login);
        $this->assertStringContainsString('id="adminLoginPasswordField" hidden', $login);
    }
}
