<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Ensures the CLX wrapper Go binary still carries the core operational
 * helpers required for parity with CDX (auth validation, auth push, startup
 * bundle, SHA256 verify, restart-loop guard). Tests check Go source files
 * under wrappers/clx/internal/ instead of the deleted bash fragments.
 */
final class ClxWrapperScriptDependencyTest extends TestCase
{
    public function testWrapperExposesValidationAndPushHelpers(): void
    {
        // freshness.go — structural auth validity check (replaces validate_auth_json_file()).
        $freshnessGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/freshness.go');
        self::assertIsString($freshnessGo, 'Expected to read wrappers/clx/internal/claude/freshness.go');
        self::assertStringContainsString('IsValidLocalAuth', $freshnessGo, 'Expected auth validation helper');

        // orchestrator/auth.go — auth push (replaces clx_auth_push()).
        $authGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/auth.go');
        self::assertIsString($authGo, 'Expected to read wrappers/clx/internal/orchestrator/auth.go');
        self::assertStringContainsString('AuthStore', $authGo, 'Expected dedicated auth push helper');
    }

    public function testWrapperIncludesStartupBundleAndFallback(): void
    {
        // bundle.go — /sync/bootstrap endpoint (replaces clx_startup_bundle_pull()).
        $bundleGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/bundle.go');
        self::assertIsString($bundleGo, 'Expected to read wrappers/clx/internal/orchestrator/bundle.go');
        self::assertStringContainsString('SyncBootstrap', $bundleGo);

        // lifecycle/run.go — orchestrates bundle + per-resource fallback
        // (replaces CLX_USE_STARTUP_BUNDLE, clx_sync_agents, clx_sync_config).
        $runGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($runGo, 'Expected to read wrappers/clx/internal/lifecycle/run.go');
        self::assertStringContainsString('SyncBootstrap', $runGo);
        self::assertStringContainsString('isBundleUnsupported', $runGo, 'Expected bundle-unsupported fallback path');
        self::assertStringContainsString('writeAgents', $runGo, 'Expected agents sync helper');
        self::assertStringContainsString('writeSettings', $runGo, 'Expected config sync helper');
    }

    public function testWrapperRequiresSha256VerificationForSelfUpdates(): void
    {
        // update/verify.go — SHA256 checksum verification for downloaded binaries.
        $verifyGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/update/verify.go');
        self::assertIsString($verifyGo, 'Expected to read wrappers/clx/internal/update/verify.go');
        self::assertStringContainsString('sha256 mismatch', $verifyGo);
        self::assertStringContainsString('sha256.New', $verifyGo);

        // update.go — calls VerifyChecksum before the atomic swap.
        $updateGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/update/update.go');
        self::assertIsString($updateGo);
        self::assertStringContainsString('VerifyChecksum', $updateGo);
    }

    public function testWrapperHasRestartLoopGuard(): void
    {
        // main.go — reads CLAUDE_WRAPPER_RESTART_DEPTH and refuses if too deep.
        $mainGo = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
        self::assertIsString($mainGo, 'Expected to read wrappers/clx/cmd/clx/main.go');
        self::assertStringContainsString('CLAUDE_WRAPPER_RESTART_DEPTH', $mainGo);
        self::assertStringContainsString('refusing to continue', $mainGo);
    }

    public function testWrapperDependencyCheckIncludesCurl(): void
    {
        // doctor.go — declares "curl" as a hard dependency.
        // (jq is not needed in Go; JSON parsing is native.)
        $doctorGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/doctor.go');
        self::assertIsString($doctorGo, 'Expected to read wrappers/clx/internal/claude/doctor.go');
        self::assertStringContainsString('"curl"', $doctorGo);
    }

    public function testVersionTokenRegexUsesProperCharClass(): void
    {
        // cron.go uses shellEscape which must handle version strings containing
        // hyphens, dots, and plus signs correctly — no shell-quoting surprises.
        // Verify needsQuoting explicitly allows these chars (-, ., +) without quoting.
        $cronGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/cron/cron.go');
        self::assertIsString($cronGo, 'Expected to read wrappers/clx/internal/cron/cron.go');
        self::assertStringContainsString("r == '/'", $cronGo, 'Expected safe-char set in needsQuoting');
        self::assertStringContainsString("r == '-'", $cronGo, 'Expected hyphen literal in safe-char set');
        self::assertStringContainsString("r == '+'", $cronGo, 'Expected plus literal in safe-char set');
    }
}
