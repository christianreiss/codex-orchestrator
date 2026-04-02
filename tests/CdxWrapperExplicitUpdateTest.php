<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperExplicitUpdateTest extends TestCase
{
    public function testExplicitUpdateRestartsOnceAfterWrapperRefreshToFinishCodexCheck(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if ((CODEX_FORCE_WRAPPER_UPDATE)) && [[ "${CODEX_UPDATE_CONTINUE_AFTER_RESTART:-0}" != "1" ]]; then',
            $wrapperSource,
            'The forced update path should suppress a second forced wrapper reinstall after restarting into the refreshed wrapper.'
        );
        self::assertStringContainsString(
            'Wrapper update completed (version ${WRAPPER_VERSION}); restarting cdx --update to finish Codex checks.',
            $wrapperSource,
            'An explicit wrapper refresh should hand off into a one-time restarted --update flow so Codex can still be updated.'
        );
        self::assertStringContainsString(
            'CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 CODEX_UPDATE_CONTINUE_AFTER_RESTART=1 exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"',
            $wrapperSource,
            'The restarted explicit update flow should preserve argv while marking that wrapper refresh already happened.'
        );
    }

    public function testExplicitUpdateSucceedsWhenWrapperAndCodexAreAlreadyCurrent(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if ((wrapper_update_failed)) || ((codex_update_failed)); then',
            $wrapperSource,
            'Explicit update should treat either wrapper or Codex update failures as a failed run.'
        );
        self::assertStringContainsString(
            'if [[ "$(lowercase "$wrapper_status_label")" == "current" ]] && [[ "$(lowercase "$codex_status_label")" == "current" ]]; then',
            $wrapperSource,
            'Explicit update should recognize the no-op success case once both components are current.'
        );
        self::assertStringContainsString(
            'log_info "Wrapper and Codex are already current."',
            $wrapperSource,
            'A no-op explicit update should exit cleanly instead of reporting that the wrapper update was not attempted.'
        );
    }
}
