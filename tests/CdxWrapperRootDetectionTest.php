<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRootDetectionTest extends TestCase
{
    public function testWrapperFallsBackToDetectedUidForRootChecks(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('DETECTED_UID="$(id -u 2>/dev/null || true)"', $wrapperSource);
        self::assertStringContainsString('if (( EUID == 0 )) || [[ "$DETECTED_UID" == "0" ]]; then', $wrapperSource);
        self::assertStringContainsString('uid=${DETECTED_UID:-unknown}', $wrapperSource);
    }

    public function testWrapperReportsDetectedUidWhenPrivilegeCheckSkipsCodexManagement(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('skip_update_reason="privilege"', $wrapperSource);
        self::assertStringContainsString(
            'codex_status_note="not permitted to manage Codex (need root; uid ${DETECTED_UID:-unknown})"',
            $wrapperSource
        );
    }

    public function testWrapperReportsDistinctSkipReasonsForCodexChecks(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('skip_update_reason="active_run"', $wrapperSource);
        self::assertStringContainsString('skip_update_reason="cron_managed"', $wrapperSource);
        self::assertStringContainsString('skip_update_reason="unsupported_platform"', $wrapperSource);
        self::assertStringContainsString('codex_status_note="cron-managed auto-update enabled"', $wrapperSource);
        self::assertStringContainsString('codex_status_note="unsupported platform (${platform_os}/${platform_arch})"', $wrapperSource);
    }
}
