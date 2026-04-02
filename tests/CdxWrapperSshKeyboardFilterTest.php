<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshKeyboardFilterTest extends TestCase
{
    public function testWrapperUsesPythonPtyBridgeForInteractiveSsh(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('is_ssh_session()', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_PTY_BRIDGE_ACTIVE=1', $wrapperSource);
        self::assertStringContainsString('ssh_should_force_no_alt_screen()', $wrapperSource);
        self::assertStringContainsString('run_codex_command_via_python_pty_bridge() {', $wrapperSource);
        self::assertStringContainsString('output_filter_re = re.compile', $wrapperSource);
        self::assertStringContainsString('<1?u', $wrapperSource);
        self::assertStringContainsString("cpr_re = re.compile(br'\\x1b\\[6n')", $wrapperSource);
        self::assertStringContainsString('os.write(child_fd, cpr_reply * cpr_count)', $wrapperSource);
        self::assertStringContainsString('tty_fd = os.open("/dev/tty", os.O_RDWR)', $wrapperSource);
        self::assertStringContainsString('normalize_plain_input_byte', $wrapperSource);
        self::assertStringContainsString('run_codex_command_via_python_pty_bridge "$tmp_output" "${exec_cmd[@]}"', $wrapperSource);
        self::assertStringContainsString('if ssh_should_force_no_alt_screen && ! codex_args_include_exact_flag "--no-alt-screen" "$@"; then', $wrapperSource);
        self::assertStringContainsString('cmd_line+=("--no-alt-screen")', $wrapperSource);
        self::assertStringNotContainsString('bridge_script="$(mktemp)"', $wrapperSource);
    }

    public function testDoctorReportsInteractiveSshBridgeMode(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('"SSH env"', $wrapperSource);
        self::assertStringContainsString('"CLI"', $wrapperSource);
        self::assertStringContainsString('session=${ssh_session_label}', $wrapperSource);
        self::assertStringContainsString('TERM=${TERM:-unknown}', $wrapperSource);
        self::assertStringContainsString('version=${LOCAL_VERSION:-unknown}', $wrapperSource);
        self::assertStringContainsString('ssh_should_force_no_alt_screen', $wrapperSource);
        self::assertStringContainsString('pty-bridge', $wrapperSource);
        self::assertStringContainsString('cpr=synthetic', $wrapperSource);
        self::assertStringContainsString('ssh-launch=direct-tty', $wrapperSource);
        self::assertStringContainsString('alt-screen=enabled', $wrapperSource);
        self::assertStringContainsString('alt-screen=disabled', $wrapperSource);
        self::assertStringNotContainsString('ssh-launch=pty-forced', $wrapperSource);
    }
}
