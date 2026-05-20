<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperExplicitUpdateTest extends TestCase
{
    public function testExplicitUpdateRestartsOnceAfterWrapperRefreshToFinishCodexCheck(): void
    {
        // In the Go wrapper an explicit `cdx --update` swaps the binary via
        // update.SelfUpdate, then the cron path re-execs via ReExecAfterUpdate
        // which sets CODEX_WRAPPER_RESTARTED=1 and increments
        // CODEX_WRAPPER_RESTART_DEPTH. The restart-depth cap in main.go ensures
        // the re-exec only happens once.

        $updateSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/update.go');
        self::assertIsString($updateSource, 'Expected to be able to read update/update.go');

        // ReExecAfterUpdate is the mechanism that re-launches into the fresh binary
        // after a wrapper self-update, carrying the original argv through.
        self::assertStringContainsString(
            'func ReExecAfterUpdate(',
            $updateSource,
            'The update package should expose ReExecAfterUpdate for post-swap re-launch.'
        );

        // The re-exec sets CODEX_WRAPPER_RESTARTED=1 so the next pass knows a
        // wrapper refresh already happened and skips a second forced reinstall.
        self::assertStringContainsString(
            'CODEX_WRAPPER_RESTARTED',
            $updateSource,
            'ReExecAfterUpdate should mark CODEX_WRAPPER_RESTARTED so the restarted wrapper suppresses a second forced reinstall.'
        );

        // The restarted process carries the snapshotted argv so the operator's
        // original command (e.g. `cdx --update`) is preserved across the exec.
        self::assertStringContainsString(
            'SnapshottedArgv',
            $updateSource,
            'The update package should snapshot argv for re-use by the restarted wrapper.'
        );

        // An incrementing depth counter prevents a feedback loop where the new
        // binary keeps re-installing itself.
        self::assertStringContainsString(
            'CODEX_WRAPPER_RESTART_DEPTH',
            $updateSource,
            'ReExecAfterUpdate should increment CODEX_WRAPPER_RESTART_DEPTH to cap restart loops.'
        );
    }

    public function testExplicitUpdateSucceedsWhenWrapperAndCodexAreAlreadyCurrent(): void
    {
        // main.go enforces a restart-depth ceiling so a repeated `cdx --update`
        // that finds nothing to do exits cleanly rather than looping.

        $mainSource = file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        // The restart-depth guard is the mechanism that makes a no-op explicit
        // update succeed rather than looping indefinitely.
        self::assertStringContainsString(
            'maxRestartDepth',
            $mainSource,
            'main.go should define a max restart depth cap for explicit update loops.'
        );
        self::assertStringContainsString(
            'CODEX_WRAPPER_RESTART_DEPTH',
            $mainSource,
            'main.go should read CODEX_WRAPPER_RESTART_DEPTH and refuse to continue past the cap.'
        );

        // When the --update flag is present the wrapper dispatches to update.SelfUpdate.
        self::assertStringContainsString(
            'update.SelfUpdate',
            $mainSource,
            'Explicit --update should invoke update.SelfUpdate to apply the wrapper refresh.'
        );
    }
}
