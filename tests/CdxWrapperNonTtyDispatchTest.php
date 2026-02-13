<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperNonTtyDispatchTest extends TestCase
{
    public function testWrapperDoesNotForceExecInNonTtyStdoutFallback(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringNotContainsString(
            'run_args=(exec "${args[@]}")',
            $wrapperSource,
            'Non-TTY stdout fallback must not rewrite argv by forcing exec.'
        );
    }

    public function testWrapperGuidesExecuteModeForNonTtyInteractiveLaunch(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'stdout is not a TTY; interactive launch requires a terminal.',
            $wrapperSource
        );
        self::assertStringContainsString(
            'Use: cdx --execute \\"<prompt>\\" [codex args...]',
            $wrapperSource
        );
    }
}
