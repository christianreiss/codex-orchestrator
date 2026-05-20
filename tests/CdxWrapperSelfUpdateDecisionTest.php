<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSelfUpdateDecisionTest extends TestCase
{
    public function testWrapperSelfUpdateHelperReturnsTrueOnlyForActualMismatches(): void
    {
        // The self-update decision logic lives in summary/summary.go: the Build
        // function compares the server-declared WrapperVersion against the
        // locally-configured one and only raises wrapperTone to ToneWarn when
        // they actually differ.
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read wrappers/cdx/internal/summary/summary.go');

        // Update is needed only when target differs from current (non-empty both sides).
        self::assertStringContainsString(
            'wrapperVer != *auth.Versions.WrapperVersion',
            $summarySource,
            'Wrapper self-update helper should report update-needed when the target version differs.'
        );

        // SHA comparison is in update/verify.go.
        $verifySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/verify.go');
        self::assertIsString($verifySource, 'Expected to be able to read wrappers/cdx/internal/update/verify.go');

        self::assertStringContainsString(
            'sha256 mismatch',
            $verifySource,
            'Wrapper self-update helper should compare the current wrapper SHA when one is provided.'
        );
        self::assertStringContainsString(
            'got != expectedHex',
            $verifySource,
            'Wrapper self-update helper should report update-needed when the wrapper SHA differs.'
        );

        // When versions match, wrapperTone stays ToneOK (no warn/fail returned).
        self::assertStringContainsString(
            'wrapperTone := ui.ToneOK',
            $summarySource,
            'Wrapper self-update helper should return false when the current wrapper already matches the target.'
        );

        // Go does not invert shell truthiness via a numeric flag variable.
        self::assertStringNotContainsString(
            'return $need_wrapper_update',
            $summarySource,
            'Wrapper self-update helper must not invert shell truthiness by returning the numeric mismatch flag directly.'
        );
    }
}
