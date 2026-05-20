<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperNonTtyDispatchTest extends TestCase
{
    public function testWrapperDoesNotForceExecInNonTtyStdoutFallback(): void
    {
        // The Go wrapper never replaces the process image for non-TTY stdout;
        // instead it tee-captures stdout via a ring-buffer while keeping the
        // child running normally under exec.CommandContext.
        $execSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource, 'Expected to be able to read wrappers/cdx/internal/codex/exec.go');

        // Ring-buffer path must be present (non-TTY fallback, not forced exec).
        self::assertStringContainsString(
            'newRingBuffer',
            $execSource,
            'Non-TTY stdout fallback must use a ring-buffer capture path, not a forced exec replacement.'
        );
        // Stdout-is-TTY guard must be present so TTY and non-TTY paths differ.
        self::assertStringContainsString(
            'stdoutIsTTY',
            $execSource,
            'Wrapper must check stdoutIsTTY to select the capture vs passthrough path.'
        );
    }

    public function testWrapperGuidesExecuteModeForNonTtyInteractiveLaunch(): void
    {
        // The Go wrapper sets PROMPT_TOOLKIT_NO_CPR=1 on non-TTY stdout/stdin
        // to prevent the upstream CLI from hanging on a cursor-position probe.
        $execSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource, 'Expected to be able to read wrappers/cdx/internal/codex/exec.go');

        self::assertStringContainsString(
            'PROMPT_TOOLKIT_NO_CPR=1',
            $execSource,
            'Non-TTY path must set PROMPT_TOOLKIT_NO_CPR=1 to suppress cursor-position probes.'
        );
        // The headless --execute flag is the Go-native alternative to an
        // interactive launch without a TTY.
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read wrappers/cdx/cmd/cdx/main.go');
        self::assertStringContainsString(
            '--execute',
            $mainSource,
            'Wrapper must expose --execute flag as the non-TTY one-shot launch path.'
        );
    }
}
