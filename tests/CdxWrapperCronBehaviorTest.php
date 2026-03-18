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
    }

    public function testReleaseAssetLookupFailsClosedWhenSpecificAssetMissing(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if asset is None and not wanted:', $wrapperSource);
        self::assertStringContainsString('error: could not find release asset {wanted}', $wrapperSource);
    }
}
