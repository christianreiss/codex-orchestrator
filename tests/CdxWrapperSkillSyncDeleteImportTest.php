<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillSyncDeleteImportTest extends TestCase
{
    public function testSkillCleanupRemovesLegacyDirectoriesAndBaselines(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('cleanup_legacy_skill_state()', $wrapperSource);
        self::assertStringContainsString('"$HOME/.agents/skills"', $wrapperSource);
        self::assertStringContainsString('"$HOME/.codex/skills"', $wrapperSource);
        self::assertStringContainsString('"$HOME/.agents/.skill-baseline.json"', $wrapperSource);
    }
}
