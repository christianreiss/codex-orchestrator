<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUpdateChecksumTest extends TestCase
{
    public function testWrapperFetchesAndCompareExpectedSha(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapperSource);

        // Metadata probe fetches expected sha before downloading the binary.
        self::assertStringContainsString("/wrapper?engine=claude", $wrapperSource);
        self::assertStringContainsString('.data.sha256 // empty', $wrapperSource);

        // Verification branch rejects mismatches with a precise operator-visible reason.
        self::assertStringContainsString('Wrapper SHA256 mismatch', $wrapperSource);
        self::assertStringContainsString('Refusing to install unverified wrapper', $wrapperSource);
    }

    public function testWrapperWarnsWhenServerDoesNotExposeSha(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('Server did not return a SHA256; falling back to shebang sanity check.', $wrapperSource);
    }
}
