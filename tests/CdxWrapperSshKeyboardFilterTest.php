<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshKeyboardFilterTest extends TestCase
{
    public function testWrapperUsesDirectTtyForInteractiveSsh(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('is_ssh_session()', $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('ssh_should_force_no_alt_screen()', $wrapperSource);
        self::assertStringContainsString("if [[ -t 0 && -t 1 ]]; then\n    \"\${exec_cmd[@]}\"\n    status=$?", $wrapperSource);
        self::assertStringContainsString('if ssh_should_force_no_alt_screen && ! codex_args_include_exact_flag "--no-alt-screen" "$@"; then', $wrapperSource);
        self::assertStringContainsString('cmd_line+=("--no-alt-screen")', $wrapperSource);
        self::assertStringNotContainsString('CODEX_SSH_PTY_BRIDGE_ACTIVE', $wrapperSource);
        self::assertStringNotContainsString('run_codex_command_via_python_pty_bridge', $wrapperSource);
        self::assertStringNotContainsString('output_filter_re = re.compile', $wrapperSource);
        self::assertStringNotContainsString("cpr_re = re.compile(br'\\x1b\\[6n')", $wrapperSource);
        self::assertStringNotContainsString('normalize_plain_input_byte', $wrapperSource);
    }

    public function testDoctorReportsInteractiveSshDirectMode(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('"SSH env"', $wrapperSource);
        self::assertStringContainsString('"CLI"', $wrapperSource);
        self::assertStringContainsString('session=${ssh_session_label}', $wrapperSource);
        self::assertStringContainsString('TERM=${TERM:-unknown}', $wrapperSource);
        self::assertStringContainsString('version=${LOCAL_VERSION:-unknown}', $wrapperSource);
        self::assertStringContainsString('ssh_should_force_no_alt_screen', $wrapperSource);
        self::assertStringContainsString('ssh-launch=direct-tty', $wrapperSource);
        self::assertStringContainsString('ssh-launch=direct-tty-inline', $wrapperSource);
        self::assertStringContainsString('alt-screen=enabled', $wrapperSource);
        self::assertStringContainsString('alt-screen=disabled', $wrapperSource);
        self::assertStringNotContainsString('pty-bridge', $wrapperSource);
        self::assertStringNotContainsString('cpr=synthetic', $wrapperSource);
        self::assertStringNotContainsString('ssh-launch=pty-forced', $wrapperSource);
    }
}
