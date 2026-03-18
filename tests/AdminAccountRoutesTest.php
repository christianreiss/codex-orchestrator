<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAccountRoutesTest extends TestCase
{
    public function testAccountBrowserRoutesAndPasswordChangeEndpointExist(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("\$router->add('GET', '#^/admin/account(?:/(password|passkeys))?\$#', function (): void {", $source);
        $this->assertStringContainsString("\$router->add('POST', '#^/admin/auth/password/change\$#', function () use (\$payload, \$adminAuthService) {", $source);
        $this->assertStringContainsString('Password confirmation does not match.', $source);
    }
}
