<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminMtlsModeEnforcementTest extends TestCase
{
    public function testRequireAdminAccessUsesMtlsMode(): void
    {
        $contents = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertNotFalse($contents);

        $this->assertStringNotContainsString('mtls_only', $contents);
        $this->assertMatchesRegularExpression('/\\$mtlsRequired\\s*=\\s*\\$mode\\s*===\\s*\\\'mtls\\\'\\s*;/', $contents);
    }
}
