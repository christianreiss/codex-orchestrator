<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureApprovalBoxFormatTest extends TestCase
{
    public function testWrapperBuildsPendingApprovalBoxWithBorderAwareWidthCalculation(): void
    {
        $sourcePath = __DIR__ . '/../wrappers/cdx/internal/ui/approval_box.go';
        $source = @file_get_contents($sourcePath);
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/approval_box.go');

        self::assertStringContainsString(
            'width < 50',
            $source,
            'Pending approval box should clamp to a stable minimum width.'
        );
        self::assertStringContainsString(
            'strings.Repeat(g.BoxH, inner)',
            $source,
            'Top and bottom borders should repeat the horizontal glyph across the full content width.'
        );
        self::assertStringContainsString(
            'g.BoxTL',
            $source,
            'Top border should use the top-left corner glyph.'
        );
        self::assertStringContainsString(
            'g.BoxBR',
            $source,
            'Bottom border should use the bottom-right corner glyph.'
        );
    }

    public function testWrapperFallsBackToAsciiBordersForDumbTerminals(): void
    {
        $sourcePath = __DIR__ . '/../wrappers/cdx/internal/ui/ansi.go';
        $source = @file_get_contents($sourcePath);
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/ansi.go');

        self::assertStringContainsString(
            'dumb',
            $source,
            'Should detect dumb terminals and fall back to ASCII box glyphs.'
        );
        self::assertStringContainsString(
            'BoxTL: "+"',
            $source,
            'ASCII fallback top-left corner should be "+".'
        );
        self::assertStringContainsString(
            'BoxH: "-"',
            $source,
            'ASCII fallback horizontal glyph should be "-".'
        );
        self::assertStringContainsString(
            'BoxV: "|"',
            $source,
            'ASCII fallback vertical glyph should be "|".'
        );
    }
}
