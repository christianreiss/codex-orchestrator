<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasswordConfirmFieldsTest extends TestCase
{
    public function testPasswordConfirmFieldsExist(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="adminResetPasswordConfirm"', $html);
        $this->assertStringContainsString('id="usersPasswordConfirm"', $html);
    }
}
