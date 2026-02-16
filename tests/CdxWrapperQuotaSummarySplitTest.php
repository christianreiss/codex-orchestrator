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

        self::assertStringContainsString('other_lane_usage_label="Quota (Spark@s)"', $wrapperSource);
        self::assertStringContainsString('other_lane_usage_label="Quota (Normal@s)"', $wrapperSource);
        self::assertStringContainsString('other_lane_usage_value="5h ${spark_5h}, week ${spark_wk}"', $wrapperSource);
        self::assertStringContainsString('other_lane_usage_value="5h ${normal_5h}, week ${normal_wk}"', $wrapperSource);
        self::assertStringContainsString('format_simple_row "$other_lane_usage_label" "$other_lane_usage_display"', $wrapperSource);
        self::assertStringNotContainsString('usage_line+=" | ${other_lane_summary}"', $wrapperSource);
    }
}
