<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSectionPackingTest extends TestCase
{
    public function testWrapperPacksSummaryRowsIntoTabbedTripletsByDefault(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('SUMMARY_ITEMS_PER_ROW=3', $wrapperSource);
        self::assertStringContainsString('packed_line+=$\'\\t\'"$line"', $wrapperSource);
        self::assertStringContainsString('if (( packed_count >= items_per_row )); then', $wrapperSource);
    }

    public function testWrapperAllowsSummaryPackingOverrideViaEnvVar(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('CODEX_SUMMARY_ITEMS_PER_ROW', $wrapperSource);
        self::assertStringContainsString('if [[ "${CODEX_SUMMARY_ITEMS_PER_ROW:-}" =~ ^[1-9][0-9]*$ ]]; then', $wrapperSource);
    }
}
