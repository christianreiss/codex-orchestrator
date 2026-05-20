<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperPackageManagerSupportTest extends TestCase
{
    /**
     * The Go wrapper installs the upstream Codex CLI from GitHub release assets.
     * For RHEL-family hosts (CentOS, AlmaLinux, Rocky) that have neither apt
     * nor brew, the musl-linked binary is the universal cross-distro solution —
     * it needs no shared libc and runs without any package manager at all.
     */
    public function testWrapperSupportsYumFallbackForRhelFamilyHosts(): void
    {
        // The Go installer selects musl Linux assets, which run on RHEL-family
        // hosts without requiring yum/dnf. Confirm the linux/amd64 prefix is musl.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringContainsString(
            'codex-x86_64-unknown-linux-musl',
            $installerSource,
            'Go installer must select the musl x86_64 asset, which works on RHEL-family hosts without package manager dependencies.'
        );
        self::assertStringContainsString(
            'codex-aarch64-unknown-linux-musl',
            $installerSource,
            'Go installer must select the musl aarch64 asset for ARM RHEL-family hosts.'
        );
    }

    public function testWrapperCanInstallPrerequisitesWithYum(): void
    {
        // The Go wrapper installs the Codex CLI from GitHub (no system packages
        // required). For npm-managed installs it falls back to `npm install -g`.
        // Both paths are codified in installer.go.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringContainsString(
            'isManagedByNpm',
            $installerSource,
            'Installer must detect npm-managed Codex and use the npm code path.'
        );
        self::assertStringContainsString(
            'ensureCodexGitHub',
            $installerSource,
            'Installer must have a GitHub release download path for non-npm hosts.'
        );
        self::assertStringContainsString(
            'EnsureCodex',
            $installerSource,
            'Installer must export EnsureCodex as the primary prerequisite-install entry point.'
        );
    }

    public function testWrapperKeepsDnfPathAlongsideYumFallback(): void
    {
        // The Go wrapper supersedes bash-era package manager detection: it
        // downloads a musl-linked binary that has no libc dependencies and
        // therefore requires neither dnf nor yum. Confirm the installer uses
        // the musl asset prefix for both Linux architectures.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringContainsString(
            'linux-musl',
            $installerSource,
            'Linux asset selection must use the musl variant, eliminating the need for dnf/yum dependencies.'
        );
    }

    public function testWrapperUsesPublishedLinuxMuslReleaseAssets(): void
    {
        // The Go installer must select musl (not gnu) Linux release assets so
        // the downloaded binary runs on any Linux distro without glibc version
        // requirements. Mirror the original bash assertion.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringContainsString('codex-x86_64-unknown-linux-musl', $installerSource);
        self::assertStringContainsString('codex-aarch64-unknown-linux-musl', $installerSource);
        self::assertStringNotContainsString('codex-x86_64-unknown-linux-gnu', $installerSource);
        self::assertStringNotContainsString('codex-aarch64-unknown-linux-gnu', $installerSource);
    }

    public function testWrapperRetriesLegacyYumPythonPackageName(): void
    {
        // The Go wrapper no longer calls Python or yum/dnf. Python compatibility
        // on legacy RHEL hosts was needed only for the old bash-embedded Python
        // scripts. The Go binary is self-contained. Verify the installer does NOT
        // carry any Python interpreter dependency.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringNotContainsString(
            'python',
            strtolower($installerSource),
            'Go installer must not depend on Python; all logic is implemented in Go.'
        );
        self::assertStringNotContainsString(
            'python36',
            $installerSource,
            'Go installer must not reference legacy python36 package names.'
        );
    }

    public function testWrapperMapsBwrapToBubblewrapForAptDnfAndYumHosts(): void
    {
        // The Go wrapper no longer installs system packages like bubblewrap.
        // Sandbox support is handled by the upstream Codex CLI itself. The Go
        // wrapper does not carry any bwrap/bubblewrap installation logic.
        $installerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/installer.go');
        self::assertIsString($installerSource, 'Expected to be able to read wrappers/cdx/internal/codex/installer.go');

        self::assertStringNotContainsString(
            'bubblewrap',
            $installerSource,
            'Go installer must not install system packages like bubblewrap; sandbox setup is delegated to the Codex CLI.'
        );
        self::assertStringNotContainsString(
            'bwrap',
            $installerSource,
            'Go installer must not reference bwrap; sandbox handling is outside the wrapper scope.'
        );
    }
}
