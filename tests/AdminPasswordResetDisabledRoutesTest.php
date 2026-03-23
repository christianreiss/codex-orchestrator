<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasswordResetDisabledRoutesTest extends TestCase
{
    public function testPasswordResetRoutesReturnGone(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/auth/password/request\$#", $source, 'Expected password request route to exist');
        $this->assertStringContainsString("#^/admin/auth/password/reset\$#", $source, 'Expected password reset route to exist');

        $controllerSource = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminAuthController.php');
        $this->assertIsString($controllerSource);

        $this->assertStringContainsString('Password reset is disabled', $controllerSource);
        $this->assertStringContainsString('], 410);', $controllerSource);
    }
}
