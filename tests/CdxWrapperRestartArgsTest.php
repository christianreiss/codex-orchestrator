<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRestartArgsTest extends TestCase
{
    public function testWrapperRestartPreservesOriginalArgs(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'CODEX_ORIGINAL_ARGS=("$@")',
            $wrapperSource,
            'Wrapper should snapshot argv before shifting positional params (e.g., profile candidates).'
        );
        self::assertStringContainsString(
            'exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"',
            $wrapperSource,
            'Wrapper self-update restart should re-exec using the original argv so `cdx resume` survives.'
        );
        self::assertStringNotContainsString(
            'exec "$SCRIPT_REAL" "$@"',
            $wrapperSource,
            'Wrapper self-update restart should not use mutated `$@` (it may have shifted the first non-flag arg).'
        );
    }
}

