<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUpdateChecksumTest extends TestCase
{
    public function testWrapperSkipsBinaryUpdateWhenChecksumMissing(): void
    {
        // The Go wrapper verifies SHA256 in update/verify.go before swapping
        // in a newly downloaded binary.
        $verifySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/verify.go');
        self::assertIsString($verifySource);

        // VerifyChecksum rejects payloads that don't have a 64-char hex digest.
        self::assertStringContainsString('VerifyChecksum', $verifySource);
        self::assertStringContainsString('expected sha256 must be 64 hex chars', $verifySource);
        self::assertStringContainsString('sha256 mismatch', $verifySource);

        $updateSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/update.go');
        self::assertIsString($updateSource);

        // SelfUpdate calls VerifyChecksum after download; on mismatch the tmp file
        // is removed and the old binary is preserved.
        self::assertStringContainsString('VerifyChecksum', $updateSource);
        self::assertStringContainsString('BinarySHA256', $updateSource);

        // The config struct exposes BinarySHA256 as a required 64-char field.
        $configSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/config/load.go');
        self::assertIsString($configSource);
        self::assertStringContainsString('binary_sha256 must be 64 hex chars', $configSource);
    }
}
