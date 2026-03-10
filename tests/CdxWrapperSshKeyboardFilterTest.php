<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshKeyboardFilterTest extends TestCase
{
    public function testWrapperIncludesInteractiveSshKeyboardFilter(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('is_ssh_session()', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_KEYBOARD_FILTER_ACTIVE=0', $wrapperSource);
        self::assertStringContainsString('run_codex_command_via_python_pty_bridge()', $wrapperSource);
        self::assertStringContainsString("output_filter_re = re.compile(br'\\x1b\\[(?:>[0-9;:]*u|<1?u)')", $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('SSH compatibility bridge active: filtering Codex keyboard-protocol escape sequences so Enter works in plain SSH terminals.', $wrapperSource);
        self::assertStringContainsString('Interactive SSH terminals can send kitty keyboard CSI-u sequences that Codex ignores.', $wrapperSource);
        self::assertStringNotContainsString('codex_ssh_regression_fallback_version()', $wrapperSource);
        self::assertStringNotContainsString('codex_status_label="Blocked on SSH"', $wrapperSource);
    }

    public function testDoctorReportsSshHintsAndKeyboardFilterState(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('Doctor ssh', $wrapperSource);
        self::assertStringContainsString('Doctor cli', $wrapperSource);
        self::assertStringContainsString('session=${ssh_session_label}', $wrapperSource);
        self::assertStringContainsString('TERM=${TERM:-unknown}', $wrapperSource);
        self::assertStringContainsString('ssh-filter=${ssh_filter_label}', $wrapperSource);
        self::assertStringContainsString('Interactive SSH compatibility filter is active; wrapper strips Codex keyboard-protocol enable sequences', $wrapperSource);
        self::assertStringContainsString('Interactive SSH session detected, but ${CODEX_SSH_KEYBOARD_FILTER_REASON:-python3 is missing}', $wrapperSource);
        self::assertStringContainsString('Interactive SSH compatibility filter is disabled; plain Codex may ignore Enter', $wrapperSource);
    }
}
