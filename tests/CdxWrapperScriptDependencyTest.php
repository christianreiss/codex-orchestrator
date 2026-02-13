<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperScriptDependencyTest extends TestCase
{
    public function testWrapperChecksScriptDependencyDuringLinuxPrereqInstall(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'ensure_commands curl unzip script',
            $wrapperSource,
            'Linux prerequisite auto-install should include script for PTY capture support.'
        );
        self::assertStringContainsString(
            'pacman:script|apk:script',
            $wrapperSource,
            'Wrapper should keep distro package mapping for script -> util-linux where needed.'
        );
    }
}
