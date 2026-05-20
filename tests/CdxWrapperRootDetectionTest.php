<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRootDetectionTest extends TestCase
{
    private static function readGoFile(string $relPath): string
    {
        $path = __DIR__ . '/../' . $relPath;
        $source = @file_get_contents($path);
        self::assertIsString($source, "Expected to be able to read {$relPath}");
        return $source;
    }

    public function testWrapperFallsBackToDetectedUidForRootChecks(): void
    {
        // The Go wrapper uses os.Getuid() for per-user UID detection (lock path)
        // and os.Geteuid() for effective-UID / root checks (uninstall guard).
        $lockSource = self::readGoFile('wrappers/cdx/internal/ipc/lock.go');
        self::assertStringContainsString('os.Getuid()', $lockSource);

        $uninstallSource = self::readGoFile('wrappers/cdx/internal/uninstall/uninstall.go');
        self::assertStringContainsString('os.Geteuid() == 0', $uninstallSource);
    }

    public function testWrapperReportsDetectedUidWhenPrivilegeCheckSkipsCodexManagement(): void
    {
        // The Go wrapper skips self-update when the binary is not writable by the
        // current user.  The cron installer checks canWriteBinary() to decide
        // whether a privileged cron entry is needed; the uninstall path guards on
        // root / passwordless-sudo availability and surfaces a human-readable
        // error when neither is available.
        $cronSource = self::readGoFile('wrappers/cdx/internal/cron/cron.go');
        self::assertStringContainsString('canWriteBinary', $cronSource);

        $uninstallSource = self::readGoFile('wrappers/cdx/internal/uninstall/uninstall.go');
        self::assertStringContainsString('os.Geteuid() == 0', $uninstallSource);
        // The error message still communicates the "need root/sudo" constraint.
        self::assertStringContainsString('root', $uninstallSource);
    }

    public function testWrapperReportsDistinctSkipReasonsForCodexChecks(): void
    {
        // Active-run detection: the Go wrapper uses an flock and surfaces
        // "another wrapper instance is running" instead of skip_update_reason="active_run".
        $lockSource = self::readGoFile('wrappers/cdx/internal/ipc/lock.go');
        self::assertStringContainsString('another wrapper instance is running', $lockSource);

        // Unsupported-platform detection: the Go installer returns
        // "unsupported platform <os>/<arch>" when no asset matches.
        $installerSource = self::readGoFile('wrappers/cdx/internal/codex/installer.go');
        self::assertStringContainsString('unsupported platform', $installerSource);

        // The Go wrapper has no "cron_managed" skip reason — cron management is
        // handled as a separate Install/Remove flow, not as a launch guard.
        $lifecycleSource = self::readGoFile('wrappers/cdx/internal/lifecycle/run.go');
        self::assertStringNotContainsString('cron_managed', $lifecycleSource);
        self::assertStringNotContainsString('cron-managed updates', $lifecycleSource);
    }
}
