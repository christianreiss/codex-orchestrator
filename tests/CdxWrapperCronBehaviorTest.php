<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperCronBehaviorTest extends TestCase
{
    public function testCronInstallUsesManagedMarkerAndEscapedCommand(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString("cron_managed_marker() {\n  printf '%s' '# cdx-managed-cron'", $wrapperSource);
        self::assertStringContainsString("printf -v quoted_cdx_path '%q' \"\$cdx_path\"", $wrapperSource);
        self::assertStringContainsString("printf -v quoted_log_file '%q' \"\$log_file\"", $wrapperSource);
        self::assertStringContainsString('cron_command="${cron_command//%/\\\\%}"', $wrapperSource);
        self::assertStringContainsString("printf 'cdx cron job installed (daily at %02d:%02d). Log: %s\\n'", $wrapperSource);
    }

    public function testCronModeDegradesWithoutFlockAndRequiresReportSuccess(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('log_warn "flock not available; cron concurrent-run guard disabled."', $wrapperSource);
        self::assertStringContainsString('cron: update report failed after retries', $wrapperSource);
        self::assertStringContainsString('for report_attempt in 1 2 3; do', $wrapperSource);
        self::assertStringContainsString('primary.verify_flags &= ~ssl.VERIFY_X509_STRICT', $wrapperSource);
        self::assertStringContainsString('fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT', $wrapperSource);
        self::assertStringContainsString('contexts.append(ssl._create_unverified_context())', $wrapperSource);
    }

    public function testWrapperReconcilesCronInstallationToMatchServerPolicy(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('cron_wrapper_entry_installed() {', $wrapperSource);
        self::assertStringContainsString('reconcile_cron_job_state() {', $wrapperSource);
        self::assertStringContainsString('if [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]]; then', $wrapperSource);
        self::assertStringContainsString('if reconcile_cron_job_state install; then', $wrapperSource);
        self::assertStringContainsString('AUTO_UPDATE_CRON_READY=1', $wrapperSource);
        self::assertStringContainsString(
            'Cron-managed auto-update is enabled by the server, but the wrapper could not ensure the cron job; falling back to startup Codex update checks.',
            $wrapperSource
        );
        self::assertStringContainsString('reconcile_cron_job_state remove || log_warn', $wrapperSource);
        self::assertStringContainsString('elif [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]] && (( AUTO_UPDATE_CRON_READY )); then', $wrapperSource);
    }

    public function testReleaseAssetLookupFailsClosedWhenSpecificAssetMissing(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if asset is None and not wanted:', $wrapperSource);
        self::assertStringContainsString('error: could not find release asset {wanted}', $wrapperSource);
    }
}
