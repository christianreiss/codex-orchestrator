<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperHelpPassthroughTest extends TestCase
{
    public function testWrapperDefinesEarlyCodexHelpPassthroughDetector(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('is_help_flag() {', $wrapperSource);
        self::assertStringContainsString('is_codex_help_passthrough_invocation() {', $wrapperSource);
        self::assertStringContainsString('--help|-h|help)', $wrapperSource);
        self::assertStringContainsString('for arg in "${@:2}"; do', $wrapperSource);
        self::assertStringContainsString('if is_help_flag "$arg"; then', $wrapperSource);
    }

    public function testWrapperBypassesBootstrapNoiseForCodexHelp(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $helpExecPos = strpos($wrapperSource, 'exec "$CODEX_REAL_BIN" "$@"');
        $lockPos = strpos($wrapperSource, 'acquire_run_lock_or_mark_concurrent || true');
        $bootScreenPos = strpos($wrapperSource, 'print_boot_screen');

        self::assertNotFalse($helpExecPos, 'Expected help passthrough exec in wrapper source');
        self::assertNotFalse($lockPos, 'Expected concurrent guard bootstrap in wrapper source');
        self::assertNotFalse($bootScreenPos, 'Expected boot screen render path in wrapper source');
        self::assertStringContainsString('is_codex_help_passthrough_invocation "$@"', $wrapperSource);
        self::assertLessThan($lockPos, $helpExecPos, 'Expected help passthrough to run before lock acquisition');
        self::assertLessThan($bootScreenPos, $helpExecPos, 'Expected help passthrough to run before boot screen rendering');
    }

    public function testWrapperKeepsWrapperOwnedCommandsOutOfHelpPassthrough(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if (( ! CODEX_STATUS_ONLY )) && (( ! CODEX_DOCTOR_ONLY )) && (( ! CODEX_DO_UNINSTALL )) && (( ! CODEX_LANE_COMMAND )) && (( ! CODEX_EXIT_AFTER_UPDATE )) && is_codex_help_passthrough_invocation "$@"; then', $wrapperSource);
    }
}
