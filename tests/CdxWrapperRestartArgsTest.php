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
        self::assertMatchesRegularExpression(
            '/if \\(\\( \\$\\{#CODEX_ORIGINAL_ARGS\\[@\\]\\} > 0 \\)\\); then\\s+CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "\\$SCRIPT_REAL" "\\$\\{CODEX_ORIGINAL_ARGS\\[@\\]\\}"\\s+fi\\s+CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "\\$SCRIPT_REAL"/',
            $wrapperSource,
            'Wrapper self-update restart should fall back to a no-arg re-exec when original argv is empty (bash 3/legacy nounset safety).'
        );
        self::assertStringNotContainsString(
            'exec "$SCRIPT_REAL" "$@"',
            $wrapperSource,
            'Wrapper self-update restart should not use mutated `$@` (it may have shifted the first non-flag arg).'
        );
    }
}
