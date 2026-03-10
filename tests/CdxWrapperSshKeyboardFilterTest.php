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
        self::assertStringContainsString('bridge_script="$(mktemp)"', $wrapperSource);
        self::assertStringContainsString('python3 "$bridge_script" "$log_path" "$keyboard_filter_active" "$@"', $wrapperSource);
        self::assertStringContainsString('tty_fd = os.open("/dev/tty", os.O_RDWR)', $wrapperSource);
        self::assertStringContainsString('termios.TIOCGWINSZ', $wrapperSource);
        self::assertStringContainsString('termios.TIOCSWINSZ', $wrapperSource);
        self::assertStringContainsString('signal.SIGWINCH', $wrapperSource);
        self::assertStringContainsString('copy_winsize(stdin_fd, child_fd)', $wrapperSource);
        self::assertStringContainsString('normalize_plain_input_byte', $wrapperSource);
        self::assertStringContainsString('if value == 0x0A:', $wrapperSource);
        self::assertStringContainsString('if 0x40 <= final_byte <= 0x7E:', $wrapperSource);
        self::assertStringContainsString('stdin_open = True', $wrapperSource);
        self::assertStringContainsString('read_fds = [child_fd]', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('SSH compatibility bridge active: filtering Codex keyboard-protocol escape sequences so Enter works in plain SSH terminals.', $wrapperSource);
        self::assertStringContainsString('Interactive SSH terminals can send kitty keyboard CSI-u sequences that Codex ignores.', $wrapperSource);
        self::assertStringNotContainsString('stdin_fd = sys.stdin.fileno()', $wrapperSource);
        self::assertStringNotContainsString('python3 - "$log_path" "$keyboard_filter_active" "$@" <<\'PY\'', $wrapperSource);
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
