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
    }
}
