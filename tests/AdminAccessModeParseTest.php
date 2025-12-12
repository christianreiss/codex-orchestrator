<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAccessModeParseTest extends TestCase
{
    public function testAdminAccessUsesAdminRequireMtlsAndDoesNotMentionPasskeys(): void
    {
        $contents = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertNotFalse($contents);
        $this->assertStringContainsString('ADMIN_REQUIRE_MTLS', $contents);
        $this->assertStringNotContainsString('ADMIN_ACCESS_MODE', $contents);
        $this->assertStringNotContainsString('mtls_and_passkey', $contents);
        $this->assertStringNotContainsString('ADMIN_PASSKEY', $contents);
    }
}
