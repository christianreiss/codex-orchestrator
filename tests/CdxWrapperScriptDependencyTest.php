<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperScriptDependencyTest extends TestCase
{
    private static function readGoFile(string $relPath): string
    {
        $path = __DIR__ . '/../' . $relPath;
        $source = @file_get_contents($path);
        self::assertIsString($source, "Expected to be able to read {$relPath}");
        return $source;
    }

    public function testWrapperUsesLinuxPrereqInstallWithoutLegacyScriptDependency(): void
    {
        // The Go wrapper's doctor check verifies `curl` as the only hard
        // runtime dependency — `script` (PTY capture) was removed in favour of
        // direct exec + pipe-mode stdout capture.
        $doctorSource = self::readGoFile('wrappers/cdx/internal/codex/doctor.go');

        self::assertStringNotContainsString(
            '"script"',
            $doctorSource,
            'script is no longer a prereq — PTY capture removed in favour of direct exec.'
        );
        self::assertStringContainsString(
            '"curl"',
            $doctorSource,
            'curl should still be a hard-required dependency checked by the doctor.'
        );

        // The installer hard-requires curl for GitHub release downloads; unzip
        // is not needed because the Go installer uses the stdlib archive/tar +
        // compress/gzip to handle .tar.gz assets directly.
        $installerSource = self::readGoFile('wrappers/cdx/internal/codex/installer.go');
        self::assertStringContainsString(
            'downloadFile',
            $installerSource,
            'Installer must use curl-equivalent HTTP download (downloadFile) for release assets.'
        );
        self::assertStringNotContainsString(
            '"unzip"',
            $installerSource,
            'unzip is not needed — the Go installer unpacks tar.gz natively via archive/tar.'
        );
    }

    public function testWrapperUpdatePathOnlyRequiresCurlForRecovery(): void
    {
        // The Go self-update path (update/update.go) only uses net/http — no
        // external curl binary is needed at all.  The explicit --update flag
        // exercises SelfUpdate() which downloads the binary directly in-process.
        $updateSource = self::readGoFile('wrappers/cdx/internal/update/update.go');
        self::assertStringContainsString(
            'SelfUpdate',
            $updateSource,
            'The explicit wrapper update path should be implemented in SelfUpdate.'
        );
        self::assertStringContainsString(
            'net/http',
            $updateSource,
            'The recovery update path should use net/http for the download (no external curl needed).'
        );
    }

    public function testVersionTokenRegexKeepsHyphenLiteral(): void
    {
        // The Go version parser uses a regex where the hyphen in the character
        // class is safely placed after other characters so it is treated as a
        // literal, not as a range — matching the bash wrapper's [0-9A-Za-z.+_-]*
        // intent without relying on the bash pattern syntax.
        $versionSource = self::readGoFile('wrappers/cdx/internal/codex/version.go');

        // The Go regex uses [-+][0-9A-Za-z.-]+ for pre-release/build metadata.
        self::assertStringContainsString('[0-9A-Za-z.-]', $versionSource);

        // The legacy bash pattern with backslash-escaped metacharacters must
        // not appear — the Go regex uses proper RE2 syntax instead.
        self::assertStringNotContainsString('[0-9A-Za-z\\.\\-\\+_]*', $versionSource);
    }
}
