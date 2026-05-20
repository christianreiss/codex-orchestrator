<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureResultTest extends TestCase
{
    public function testWrapperUsesCompactInsecureResultLabel(): void
    {
        $sourcePath = __DIR__ . '/../wrappers/cdx/internal/summary/summary.go';
        $source = @file_get_contents($sourcePath);
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/summary/summary.go');

        self::assertStringContainsString(
            'Synced on insecure host; auth refreshed.',
            $source,
            'Expected compact insecure-host result label to be present when auth was synced'
        );
    }

    public function testWrapperHasConcurrentCompactSummaryPath(): void
    {
        $screenPath = __DIR__ . '/../wrappers/cdx/internal/ui/screen.go';
        $screenSource = @file_get_contents($screenPath);
        self::assertIsString($screenSource, 'Expected to be able to read wrappers/cdx/internal/ui/screen.go');

        $healthPath = __DIR__ . '/../wrappers/cdx/internal/ui/health.go';
        $healthSource = @file_get_contents($healthPath);
        self::assertIsString($healthSource, 'Expected to be able to read wrappers/cdx/internal/ui/health.go');

        self::assertStringContainsString(
            'in.Concurrent',
            $screenSource,
            'Boot screen should branch on the concurrent flag.'
        );
        self::assertStringContainsString(
            'Using local auth.json.',
            $healthSource,
            'Concurrent row default note should say "Using local auth.json."'
        );
        self::assertStringContainsString(
            '"concurrent run"',
            $screenSource,
            'Context line should include a "concurrent run" label when running in concurrent mode.'
        );
    }
}
