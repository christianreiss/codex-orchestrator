<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperQuotaSummarySplitTest extends TestCase
{
    public function testWrapperUsesDedicatedOtherLaneQuotaBars(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('other_lane_label="Spark"', $wrapperSource);
        self::assertStringContainsString('other_lane_label="Normal"', $wrapperSource);
        self::assertStringContainsString('other_lane_primary_quota_segment=', $wrapperSource);
        self::assertStringContainsString('other_lane_secondary_quota_segment=', $wrapperSource);
        self::assertStringContainsString('format_quota_metric_row "${other_lane_label} 5h window" "${other_lane_primary_quota_segment}"', $wrapperSource);
        self::assertStringContainsString('format_quota_metric_row "${other_lane_label} weekly window" "${other_lane_secondary_quota_segment}"', $wrapperSource);
        self::assertStringContainsString('print_section_rows "Quota" "${quota_rows[@]}"', $wrapperSource);
        self::assertStringNotContainsString('other_lane_usage_value="Spark: 5h ${spark_5h}, week ${spark_wk}"', $wrapperSource);
    }

    public function testWrapperAlignsQuotaGraphRowsUsingSharedMetricFormatter(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('format_quota_metric_row() {', $wrapperSource);
        self::assertStringContainsString('printf "%-${width}s: %s" "$label" "$value"', $wrapperSource);
        self::assertStringContainsString('quota_rows+=("${bullet} $(format_quota_metric_row "5h window" "${primary_quota_segment}")")', $wrapperSource);
        self::assertStringContainsString('quota_rows+=("${bullet} $(format_quota_metric_row "Weekly window" "${secondary_quota_segment}")")', $wrapperSource);
    }
}
