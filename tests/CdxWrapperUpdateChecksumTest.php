<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUpdateChecksumTest extends TestCase
{
    public function testWrapperSkipsBinaryUpdateWhenChecksumMissing(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('Codex update skipped: missing trusted checksum', $wrapperSource);
        self::assertStringContainsString('perform_update "$CODEX_REAL_BIN" "$remote_url" "${remote_asset:-$asset_name}" "$norm_remote" "$remote_sha256"', $wrapperSource);
        self::assertStringContainsString('Checksum mismatch for Codex', $wrapperSource);
    }
}
