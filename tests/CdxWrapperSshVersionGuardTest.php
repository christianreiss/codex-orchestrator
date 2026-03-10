<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CdxWrapperSshVersionGuardTest extends TestCase
{
    public function testWrapperIncludesInteractiveSshVersionFallback(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('is_ssh_session()', $wrapperSource);
        self::assertStringContainsString('codex_ssh_regression_fallback_version()', $wrapperSource);
        self::assertStringContainsString("0.113.0)\n      printf '0.112.0'", $wrapperSource);
        self::assertStringContainsString('CODEX_SSH_INTERACTIVE=1', $wrapperSource);
        self::assertStringContainsString('SSH safeguard: Codex ${CODEX_SSH_GUARD_BLOCKED_VERSION} is blocked for interactive SSH sessions', $wrapperSource);
        self::assertStringContainsString('codex_status_label="Blocked on SSH"', $wrapperSource);
        self::assertStringContainsString('codex_status_note="${CODEX_SSH_GUARD_BLOCKED_VERSION}→${CODEX_SSH_GUARD_FALLBACK_VERSION} safeguard"', $wrapperSource);
    }

    public function testDoctorReportsSshHintsAndGuardState(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('Doctor ssh', $wrapperSource);
        self::assertStringContainsString('Doctor cli', $wrapperSource);
        self::assertStringContainsString('session=${ssh_session_label}', $wrapperSource);
        self::assertStringContainsString('TERM=${TERM:-unknown}', $wrapperSource);
        self::assertStringContainsString('ssh-guard=${codex_guard_label}', $wrapperSource);
        self::assertStringContainsString('Interactive SSH sessions are blocked on Codex ${CODEX_SSH_GUARD_BLOCKED_VERSION:-unknown}', $wrapperSource);
    }
}
