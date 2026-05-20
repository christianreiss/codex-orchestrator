<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillFormatTest extends TestCase
{
    public function testWrapperUsesMcpForSkillsInsteadOfLocalSync(): void
    {
        $skillsSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/skills.go');
        self::assertIsString($skillsSource, 'Expected to be able to read wrappers/cdx/internal/lifecycle/skills.go');

        self::assertStringContainsString(
            'via MCP',
            $skillsSource,
            'Wrapper should report MCP-backed skill access.'
        );
        self::assertStringContainsString(
            'pruneLegacySkillDirs',
            $skillsSource,
            'Wrapper should clean up legacy local skill directories on upgrade.'
        );
        self::assertStringContainsString(
            'pruned legacy skill cache',
            $skillsSource,
            'Wrapper cleanup should prune stale local skill trees.'
        );
        self::assertStringContainsString(
            'legacy skill dir prune failed',
            $skillsSource,
            'Wrapper cleanup should prune stale skill baselines.'
        );

        // The lifecycle run.go must call both syncSkills and pruneLegacySkillDirs.
        $runSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($runSource, 'Expected to be able to read wrappers/cdx/internal/lifecycle/run.go');

        self::assertStringContainsString(
            'syncSkills',
            $runSource,
            'Wrapper should still trigger the legacy cleanup hook during bootstrap.'
        );
        self::assertStringContainsString(
            'pruneLegacySkillDirs',
            $runSource,
            'Wrapper should still trigger the legacy cleanup hook during bootstrap.'
        );
    }
}
