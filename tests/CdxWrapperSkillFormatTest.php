<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillFormatTest extends TestCase
{
    public function testWrapperWritesSkillsToSkillMd(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'SKILL.md',
            $wrapperSource,
            'Wrapper should sync skills into <slug>/SKILL.md directories.'
        );
        self::assertStringContainsString(
            '$HOME/.agents/skills',
            $wrapperSource,
            'Wrapper should sync skills into ~/.agents/skills.'
        );
        self::assertStringNotContainsString(
            '$HOME/.codex/skills',
            $wrapperSource,
            'Wrapper should no longer use the legacy ~/.codex/skills path.'
        );
    }

    public function testWrapperKeepsManagedSkillsReadOnlyDuringPushSync(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if skill.get("managed"):',
            $wrapperSource,
            'Managed skill metadata should be preserved in the skill baseline.'
        );
        self::assertStringContainsString(
            'if baseline_managed(baseline_entry):',
            $wrapperSource,
            'Managed skills should be skipped during wrapper-side skill push.'
        );
        self::assertStringContainsString(
            '{"sha": sha, "managed": True}',
            $wrapperSource,
            'Managed skill baseline entries should keep both sha and managed metadata.'
        );
    }

    public function testWrapperPrunesManagedSkillsThatDisappearFromRemoteListings(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'Managed skills that disappear from the remote list should be pruned locally on the next sync.',
            $wrapperSource,
            'Managed project skills should be deleted locally when the server stops advertising them.'
        );
        self::assertStringContainsString(
            'if slug in listed_slugs:',
            $wrapperSource,
            'Managed skill pruning should skip remote slugs that are still advertised.'
        );
        self::assertStringContainsString(
            'if not (isinstance(baseline_entry, dict) and baseline_entry.get("managed")):',
            $wrapperSource,
            'Only managed baseline entries should be auto-pruned.'
        );
    }

    public function testWrapperAlsoPrunesLegacyManagedSkillCopies(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'legacy_skill_dir = pathlib.Path.home() / ".codex" / "skills"',
            $wrapperSource,
            'Wrapper should know where legacy per-user skill copies live so stale managed skills can be removed.'
        );
        self::assertStringContainsString(
            'Legacy managed-skill copies under ~/.codex/skills should not shadow synced skills.',
            $wrapperSource,
            'Managed project skills should remove stale legacy copies during pull sync.'
        );
        self::assertStringContainsString(
            'removed += prune_legacy_skill_copy(slug)',
            $wrapperSource,
            'Managed-skill pull sync should prune stale legacy copies when present.'
        );
    }
}
