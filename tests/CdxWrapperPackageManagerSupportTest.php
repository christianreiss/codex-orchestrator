<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperPackageManagerSupportTest extends TestCase
{
    public function testWrapperSupportsYumFallbackForRhelFamilyHosts(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if command -v yum >/dev/null 2>&1; then',
            $wrapperSource,
            'RHEL-family package manager detection should include yum fallback for legacy CentOS hosts.'
        );
        self::assertStringContainsString(
            "printf '%s' yum",
            $wrapperSource,
            'Wrapper should resolve yum when dnf is unavailable.'
        );
    }

    public function testWrapperCanInstallPrerequisitesWithYum(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            "yum)\n          log_info \"Installing prerequisites",
            $wrapperSource,
            'Linux prerequisite installation should include a yum branch.'
        );
        self::assertStringContainsString(
            'yum install -y "${install_missing[@]}"',
            $wrapperSource,
            'Yum branch should install missing prerequisite packages non-interactively.'
        );
        self::assertStringContainsString(
            'pacman:script | apk:script | dnf:script | yum:script',
            $wrapperSource,
            'script dependency should map to util-linux for package managers where script is not a package name.'
        );
        self::assertStringContainsString(
            'ensure_optional_commands bwrap',
            $wrapperSource,
            'Linux hosts should attempt bubblewrap install best-effort instead of failing startup.'
        );
    }

    public function testWrapperKeepsDnfPathAlongsideYumFallback(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('dnf install -y "${install_missing[@]}"', $wrapperSource);
    }

    public function testWrapperMapsBwrapToBubblewrapForAptDnfAndYumHosts(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'apt-get:bwrap | dnf:bwrap | yum:bwrap',
            $wrapperSource,
            'APT/DNF/YUM hosts should remap the bwrap command to the bubblewrap package name.'
        );
        self::assertStringContainsString(
            'pkg="bubblewrap"',
            $wrapperSource,
            'APT/DNF/YUM hosts should install the bubblewrap package when bwrap is missing.'
        );
    }
}
