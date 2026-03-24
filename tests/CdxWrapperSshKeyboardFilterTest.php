<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshKeyboardFilterTest extends TestCase
{
    public function testWrapperUsesDirectTtyForInteractiveSshWithoutKeyboardFilter(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('is_ssh_session()', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('if (( CODEX_SSH_INTERACTIVE )) && [[ "${CODEX_FORCE_PTY:-0}" != "1" ]]; then', $wrapperSource);
        self::assertStringContainsString('Interactive SSH is more reliable with a direct TTY handoff than nested PTY capture.', $wrapperSource);
        self::assertStringContainsString('if [[ "$CODEX_NO_PTY" == "1" ]]; then', $wrapperSource);
        self::assertStringContainsString('script $SCRIPT_FLAGS "$tmp_output" -c "$cmd_str"', $wrapperSource);
        self::assertStringContainsString('local -a pty_cmd=(python3 - "$tmp_output" "${cmd_line[@]}")', $wrapperSource);
        self::assertStringNotContainsString('CODEX_SSH_KEYBOARD_FILTER_ACTIVE=0', $wrapperSource);
        self::assertStringNotContainsString('run_codex_command_via_python_pty_bridge()', $wrapperSource);
        self::assertStringNotContainsString("output_filter_re = re.compile(br'\\x1b\\[(?:>[0-9;:]*u|<1?u)')", $wrapperSource);
        self::assertStringNotContainsString('bridge_script="$(mktemp)"', $wrapperSource);
        self::assertStringNotContainsString('tty_fd = os.open("/dev/tty", os.O_RDWR)', $wrapperSource);
        self::assertStringNotContainsString('normalize_plain_input_byte', $wrapperSource);
        self::assertStringNotContainsString('SSH compatibility bridge active: filtering Codex keyboard-protocol escape sequences so Enter works in plain SSH terminals.', $wrapperSource);
        self::assertStringNotContainsString('Interactive SSH terminals can send kitty keyboard CSI-u sequences that Codex ignores.', $wrapperSource);
        self::assertStringNotContainsString('stdin_fd = sys.stdin.fileno()', $wrapperSource);
        self::assertStringNotContainsString('codex_ssh_regression_fallback_version()', $wrapperSource);
        self::assertStringNotContainsString('codex_status_label="Blocked on SSH"', $wrapperSource);
    }

    public function testDoctorReportsInteractiveSshDirectLaunchMode(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('"SSH env"', $wrapperSource);
        self::assertStringContainsString('"CLI"', $wrapperSource);
        self::assertStringContainsString('session=${ssh_session_label}', $wrapperSource);
        self::assertStringContainsString('TERM=${TERM:-unknown}', $wrapperSource);
        self::assertStringContainsString('version=${LOCAL_VERSION:-unknown}', $wrapperSource);
        self::assertStringContainsString('ssh-launch=direct-tty', $wrapperSource);
        self::assertStringContainsString('ssh-launch=pty-forced', $wrapperSource);
        self::assertStringNotContainsString('ssh-filter=${ssh_filter_label}', $wrapperSource);
        self::assertStringNotContainsString('Interactive SSH compatibility filter is active; wrapper strips Codex keyboard-protocol enable sequences', $wrapperSource);
        self::assertStringNotContainsString('Interactive SSH session detected, but ${CODEX_SSH_KEYBOARD_FILTER_REASON:-python3 is missing}', $wrapperSource);
        self::assertStringNotContainsString('Interactive SSH compatibility filter is disabled; plain Codex may ignore Enter', $wrapperSource);
    }
}
