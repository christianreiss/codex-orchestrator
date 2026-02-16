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

        $requestRoute = "\$router->add('POST', '#^/admin/auth/password/request$#'";
        $resetRoute = "\$router->add('POST', '#^/admin/auth/password/reset$#'";

        $requestPos = strpos($source, $requestRoute);
        $resetPos = strpos($source, $resetRoute);
        $this->assertNotFalse($requestPos, 'Expected password request route to exist');
        $this->assertNotFalse($resetPos, 'Expected password reset route to exist');

        $requestChunk = substr($source, (int) $requestPos, 420);
        $resetChunk = substr($source, (int) $resetPos, 420);

        $this->assertIsString($requestChunk);
        $this->assertIsString($resetChunk);
        $this->assertStringContainsString('Password reset is disabled', $requestChunk);
        $this->assertStringContainsString('], 410);', $requestChunk);
        $this->assertStringContainsString('Password reset is disabled', $resetChunk);
        $this->assertStringContainsString('], 410);', $resetChunk);
    }
}
