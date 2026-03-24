<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSelfUpdateDecisionTest extends TestCase
{
    public function testWrapperSelfUpdateHelperReturnsTrueOnlyForActualMismatches(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            "if [[ -n \"\$target_wrapper\" && \"\$target_wrapper\" != \"\${WRAPPER_VERSION:-}\" ]]; then\n    return 0",
            $wrapperSource,
            'Wrapper self-update helper should report update-needed when the target version differs.'
        );
        self::assertStringContainsString(
            "if [[ -n \"\$target_wrapper_sha\" ]]; then\n    local current_wrapper_sha=\"\"",
            $wrapperSource,
            'Wrapper self-update helper should compare the current wrapper SHA when one is provided.'
        );
        self::assertStringContainsString(
            "if [[ \"\$current_wrapper_sha\" != \"\$target_wrapper_sha\" ]]; then\n        return 0",
            $wrapperSource,
            'Wrapper self-update helper should report update-needed when the wrapper SHA differs.'
        );
        self::assertStringContainsString(
            "  return 1\n}",
            $wrapperSource,
            'Wrapper self-update helper should return false when the current wrapper already matches the target.'
        );
        self::assertStringNotContainsString(
            'return $need_wrapper_update',
            $wrapperSource,
            'Wrapper self-update helper must not invert shell truthiness by returning the numeric mismatch flag directly.'
        );
    }
}
