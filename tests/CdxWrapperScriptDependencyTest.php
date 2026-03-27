<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperScriptDependencyTest extends TestCase
{
    public function testWrapperUsesLinuxPrereqInstallWithoutLegacyScriptDependency(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringNotContainsString(
            'ensure_commands curl unzip script',
            $wrapperSource,
            'script is no longer a prereq — PTY capture removed in favour of direct exec.'
        );
        self::assertStringContainsString(
            'ensure_commands curl unzip',
            $wrapperSource,
            'Linux prerequisite auto-install should still hard-require curl and unzip.'
        );
        self::assertStringContainsString(
            'ensure_optional_commands bwrap',
            $wrapperSource,
            'Bubblewrap should stay best-effort so missing distro packages do not block Codex startup.'
        );
    }

    public function testWrapperUpdatePathOnlyRequiresCurlForRecovery(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if (( CODEX_EXIT_AFTER_UPDATE )); then',
            $wrapperSource,
            'The explicit wrapper update path should branch before the normal prerequisite set.'
        );
        self::assertStringContainsString(
            'ensure_commands curl',
            $wrapperSource,
            'The recovery update path should only require curl.'
        );
    }
}
