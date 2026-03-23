<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAccountRoutesTest extends TestCase
{
    public function testAccountBrowserRoutesAndPasswordChangeEndpointExist(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminAuthController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("#^/admin/account(?:/(password|passkeys))?\$#", $source);
        $this->assertStringContainsString("#^/admin/auth/password/change\$#", $source);
        $this->assertStringContainsString('Password confirmation does not match.', $source);
    }
}
