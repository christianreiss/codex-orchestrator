<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSummarySectionsTest extends TestCase
{
    public function testWrapperRendersSectionedSummaryRows(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('print_section_rows "Health"', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Versions"', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Usage"', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Quota"', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Result"', $wrapperSource);
    }

    public function testWrapperUsesReadableUsageLabels(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('API calls (host total)', $wrapperSource);
        self::assertStringContainsString('Tokens this month', $wrapperSource);
        self::assertStringContainsString('5h window', $wrapperSource);
        self::assertStringContainsString('Weekly window', $wrapperSource);
    }
}
