<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillSyncDeleteImportTest extends TestCase
{
    public function testSkillCleanupRemovesLegacyDirectoriesAndBaselines(): void
    {
        $skillsSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/skills.go');
        self::assertIsString($skillsSource, 'Expected to be able to read wrappers/cdx/internal/lifecycle/skills.go');

        self::assertStringContainsString('pruneLegacySkillDirs', $skillsSource);
        // Legacy ~/.agents/skills directory is targeted for removal.
        self::assertStringContainsString('".agents", "skills"', $skillsSource);
        // Legacy ~/.codex/skills directory is targeted for removal.
        self::assertStringContainsString('".codex", "skills"', $skillsSource);
        // Legacy ~/.codex/prompts directory is also pruned.
        self::assertStringContainsString('".codex", "prompts"', $skillsSource);
    }
}
