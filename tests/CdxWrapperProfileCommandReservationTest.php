<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperProfileCommandReservationTest extends TestCase
{
    public function testWrapperReservesKnownCodexSubcommandsFromProfileShorthand(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('is_reserved_codex_command()', $wrapperSource);
        self::assertStringContainsString(
            'exec | review | login | logout | mcp | mcp-server | app-server | completion | sandbox | debug | apply | resume | fork | cloud | features | help',
            $wrapperSource
        );
    }

    public function testWrapperOnlyUsesProfileShorthandForNonReservedFirstArgs(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if ! is_reserved_codex_command "${1-}"; then', $wrapperSource);
        self::assertStringContainsString('CODEX_PROFILE_CANDIDATE="$1"', $wrapperSource);
    }
}
