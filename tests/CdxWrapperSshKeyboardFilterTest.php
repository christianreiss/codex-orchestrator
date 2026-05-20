<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshKeyboardFilterTest extends TestCase
{
    public function testWrapperUsesDirectTtyForInteractiveSsh(): void
    {
        // The bash wrapper's Python PTY bridge was removed. The Go wrapper sets
        // PROMPT_TOOLKIT_NO_CPR=1 when not running in a TTY so the upstream
        // codex CLI (prompt_toolkit) does not probe cursor position over a pipe.
        $execSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource);

        self::assertStringContainsString('PROMPT_TOOLKIT_NO_CPR=1', $execSource);
        self::assertStringContainsString('stdinIsTTY', $execSource);
        self::assertStringContainsString('stdoutIsTTY', $execSource);

        // The old Python PTY bridge artefacts must not exist anywhere in Go source.
        self::assertStringNotContainsString('output_filter_re = re.compile', $execSource);
        self::assertStringNotContainsString('normalize_plain_input_byte', $execSource);
    }

    public function testDoctorReportsInteractiveSshDirectMode(): void
    {
        $doctorSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/doctor.go');
        self::assertIsString($doctorSource);

        // The doctor table has "SSH env" and "CLI" rows — stable contract.
        self::assertStringContainsString('"SSH env"', $doctorSource);
        self::assertStringContainsString('"CLI"', $doctorSource);

        // SSH detection reads the canonical env vars.
        self::assertStringContainsString('SSH_TTY', $doctorSource);
        self::assertStringContainsString('SSH_CONNECTION', $doctorSource);
        self::assertStringContainsString('TERM', $doctorSource);

        // No legacy PTY-bridge artefacts in the doctor.
        self::assertStringNotContainsString('pty-bridge', $doctorSource);
        self::assertStringNotContainsString('cpr=synthetic', $doctorSource);
    }
}
