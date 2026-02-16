<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperQuotaSummarySplitTest extends TestCase
{
    public function testWrapperUsesDedicatedOtherLaneQuotaSummaryRow(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('other_lane_usage_value="Spark: 5h ${spark_5h}, week ${spark_wk}"', $wrapperSource);
        self::assertStringContainsString('other_lane_usage_value="Normal: 5h ${normal_5h}, week ${normal_wk}"', $wrapperSource);
        self::assertStringContainsString('quota_rows+=("${bullet} ${other_lane_usage_value}")', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Quota" "${quota_rows[@]}"', $wrapperSource);
        self::assertStringNotContainsString('usage_line+=" | ${other_lane_summary}"', $wrapperSource);
    }
}
