<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAccessModeTest extends TestCase
{
    public function testAdminAccessModeUsesAdminAccessModeEnv(): void
    {
        $contents = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertNotFalse($contents);
        $this->assertStringContainsString('ADMIN_ACCESS_MODE', $contents);
        $this->assertStringNotContainsString('ADMIN_REQUIRE_MTLS', $contents);
        $this->assertStringNotContainsString('mtls_and_passkey', $contents);
        $this->assertStringNotContainsString('ADMIN_PASSKEY', $contents);
    }
}

