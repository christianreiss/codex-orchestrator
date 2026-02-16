<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSectionPackingTest extends TestCase
{
    public function testWrapperPacksSummaryRowsIntoAlignedColumnsByDefault(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('SUMMARY_ITEMS_PER_ROW=3', $wrapperSource);
        self::assertStringContainsString('SUMMARY_COLUMN_GAP=4', $wrapperSource);
        self::assertStringContainsString('section_entries+=("$line")', $wrapperSource);
        self::assertStringContainsString('column_widths[col]=0', $wrapperSource);
        self::assertStringContainsString('row_text+="$padded_entry"', $wrapperSource);
        self::assertStringNotContainsString('(( packed_count++ ))', $wrapperSource);
        self::assertStringNotContainsString('packed_line+=$\'\\t\'"$line"', $wrapperSource);
    }

    public function testWrapperAllowsSummaryPackingOverrideViaEnvVar(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('CODEX_SUMMARY_ITEMS_PER_ROW', $wrapperSource);
        self::assertStringContainsString('if [[ "${CODEX_SUMMARY_ITEMS_PER_ROW:-}" =~ ^[1-9][0-9]*$ ]]; then', $wrapperSource);
        self::assertStringContainsString('CODEX_SUMMARY_ITEMS_PER_ROW_${label_key}', $wrapperSource);
    }

    public function testWrapperDefaultsQuotaSectionToThreeItemsPerRow(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('SUMMARY_ITEMS_PER_ROW_QUOTA=3', $wrapperSource);
        self::assertStringContainsString('if [[ "$label" == "Quota" ]]; then', $wrapperSource);
        self::assertStringContainsString('items_per_row="${SUMMARY_ITEMS_PER_ROW_QUOTA:-3}"', $wrapperSource);
    }
}
