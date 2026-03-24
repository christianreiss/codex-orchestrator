<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillFormatTest extends TestCase
{
    public function testWrapperUsesMcpForSkillsInsteadOfLocalSync(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'skills via MCP',
            $wrapperSource,
            'Wrapper should report MCP-backed skill access.'
        );
        self::assertStringContainsString(
            'cleanup_legacy_skill_state()',
            $wrapperSource,
            'Wrapper should clean up legacy local skill directories on upgrade.'
        );
        self::assertStringContainsString(
            'remove_path "$path" "legacy local skills"',
            $wrapperSource,
            'Wrapper cleanup should prune stale local skill trees.'
        );
        self::assertStringContainsString(
            'remove_path "$path" "legacy skill baseline"',
            $wrapperSource,
            'Wrapper cleanup should prune stale skill baselines.'
        );
        self::assertStringContainsString(
            'sync_skills_pull || true',
            $wrapperSource,
            'Wrapper should still trigger the legacy cleanup hook during bootstrap.'
        );
    }
}
