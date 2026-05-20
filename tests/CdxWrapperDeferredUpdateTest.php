<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperDeferredUpdateTest extends TestCase
{
    public function testCodexUpdateIsDeferredWhenWrapperRestartIsPending(): void
    {
        // In the Go wrapper the cron Tick performs a wrapper self-update first.
        // After the binary is swapped it re-execs itself (via ReExecAfterUpdate).
        // The freshly started process detects CODEX_WRAPPER_RESTARTED=1 and
        // aborts the cron Tick with a "wrapper update loop detected" guard so the
        // Codex CLI update never runs in the same pass as the wrapper swap — it is
        // effectively deferred to the next scheduled cron tick.

        $cronSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/cron/cron.go');
        self::assertIsString($cronSource, 'Expected to be able to read cron/cron.go');

        // Re-exec with CODEX_WRAPPER_RESTARTED=1 is the mechanism that prevents
        // the Codex update from running in the same pass as the wrapper swap.
        $updateSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/update.go');
        self::assertIsString($updateSource, 'Expected to be able to read update/update.go');

        // The update package sets CODEX_WRAPPER_RESTARTED on re-exec.
        self::assertStringContainsString('CODEX_WRAPPER_RESTARTED', $updateSource);

        // The cron Tick checks CODEX_WRAPPER_RESTARTED to detect a loop after
        // wrapper self-update — this is the guard that prevents a second wrapper
        // swap from running before the deferred Codex update.
        self::assertStringContainsString('CODEX_WRAPPER_RESTARTED', $cronSource);
        self::assertStringContainsString('wrapper update loop detected', $cronSource);

        // The Codex update block only runs after the wrapper-update guard, ensuring
        // the wrapper restart always completes before any Codex update is applied.
        // Use the logger call as the search target to land in the actual code body
        // rather than in the package-level doc comment.
        $wrapperUpdatePos = strpos($cronSource, 'wrapper update loop detected');
        $codexUpdatePos   = strpos($cronSource, '"cron: Codex update"');
        self::assertNotFalse($wrapperUpdatePos, 'Expected wrapper-restart guard in cron source');
        self::assertNotFalse($codexUpdatePos,   'Expected Codex update log call in cron source');
        self::assertLessThan($codexUpdatePos, $wrapperUpdatePos,
            'Expected wrapper-restart guard to appear before the Codex update block');
    }
}
