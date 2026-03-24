<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperScriptDependencyTest extends TestCase
{
    public function testWrapperDoesNotRequireScriptForLinuxPrereqInstall(): void
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
            'Linux prerequisite auto-install should still include curl and unzip.'
        );
    }
}
