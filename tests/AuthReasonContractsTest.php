<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AuthReasonContractsTest extends TestCase
{
    public function testServerEmitsStableAuthDenyReasonCodes(): void
    {
        $serviceSource = @file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        self::assertIsString($serviceSource);

        self::assertStringContainsString("'code' => 'reverse_dns_mismatch'", $serviceSource);
        self::assertStringContainsString("'code' => 'insecure_api_disabled'", $serviceSource);
        self::assertStringContainsString("'expected_ip' => \$storedIp4", $serviceSource);
        self::assertStringContainsString("'received_ip' => \$normalizedIp", $serviceSource);
    }

    public function testWrapperMapsStableAuthDenyReasonCodes(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('print("denied:reverse_dns_mismatch")', $wrapperSource);
        self::assertStringContainsString('sys.exit(24)', $wrapperSource);
        self::assertStringContainsString('sys.exit(27)', $wrapperSource);
        self::assertStringContainsString('sys.exit(40)', $wrapperSource);

        self::assertStringContainsString('Auth sync blocked: API disabled by administrator', $wrapperSource);
        self::assertStringContainsString('Auth sync blocked: insecure host window is closed', $wrapperSource);
        self::assertStringContainsString('Auth sync denied: ${reason_label}; PTR must resolve to host FQDN.', $wrapperSource);
        self::assertStringContainsString('Auth sync blocked: insecure host approval denied.', $wrapperSource);
    }
}
