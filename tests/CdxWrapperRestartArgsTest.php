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
            'CODEX_ORIGINAL_ARGC=$#',
            $wrapperSource,
            'Wrapper should snapshot the original argc so legacy bash can test empty argv without expanding an empty array under `set -u`.'
        );
        self::assertStringContainsString(
            'exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"',
            $wrapperSource,
            'Wrapper self-update restart should re-exec using the original argv so `cdx resume` survives.'
        );
        self::assertMatchesRegularExpression(
            '/if \\(\\( CODEX_ORIGINAL_ARGC > 0 \\)\\); then\\s+CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "\\$SCRIPT_REAL" "\\$\\{CODEX_ORIGINAL_ARGS\\[@\\]\\}"\\s+fi\\s+CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "\\$SCRIPT_REAL"/',
            $wrapperSource,
            'Wrapper self-update restart should fall back to a no-arg re-exec when original argv is empty (Bash 4.2/CentOS 7 nounset safety).'
        );
        self::assertMatchesRegularExpression(
            '/if \\(\\( CODEX_ORIGINAL_ARGC > 0 \\)\\) && declare -p CODEX_ORIGINAL_ARGS >\\/dev\\/null 2>&1; then\\s+argv_text="\\$\\(printf \\\'%q \\\' "\\$\\{CODEX_ORIGINAL_ARGS\\[@\\]\\}"\\)"/',
            $wrapperSource,
            'Run-lock metadata formatting should only expand original argv when the snapshotted argc says args were present.'
        );
        self::assertStringNotContainsString(
            '${#CODEX_ORIGINAL_ARGS[@]}',
            $wrapperSource,
            'Wrapper self-update restart should not test empty argv by expanding an empty array under `set -u` on legacy bash.'
        );
        self::assertStringNotContainsString(
            'exec "$SCRIPT_REAL" "$@"',
            $wrapperSource,
            'Wrapper self-update restart should not use mutated `$@` (it may have shifted the first non-flag arg).'
        );
    }
}
