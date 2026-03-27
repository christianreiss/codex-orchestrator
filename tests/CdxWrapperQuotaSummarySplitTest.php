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
        self::assertStringContainsString('if [[ "${other_lane_primary_used:-}" =~ ^[0-9]+$ ]]; then', $wrapperSource);
        self::assertStringContainsString('if [[ "${other_lane_secondary_used:-}" =~ ^[0-9]+$ ]]; then', $wrapperSource);
        self::assertStringContainsString('q_labels+=("5h");       q_used+=("$other_lane_primary_used")', $wrapperSource);
        self::assertStringContainsString('q_labels+=("weekly");   q_used+=("$other_lane_secondary_used")', $wrapperSource);
        self::assertStringNotContainsString('other_lane_usage_value="Spark: 5h ${spark_5h}, week ${spark_wk}"', $wrapperSource);
    }

    public function testWrapperAlignsQuotaGraphRowsUsingSharedMetricFormatter(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('format_quota_metric_row() {', $wrapperSource);
        self::assertStringContainsString('printf "%-${width}s: %s" "$label" "$value"', $wrapperSource);
        self::assertStringContainsString('padded_label="$(pad_visible_text_right "$full_label" "$max_lw")"', $wrapperSource);
        self::assertStringContainsString('printf "  %s %s [%s]" "$padded_label" "$pct_display" "$bar"', $wrapperSource);
        self::assertStringContainsString('[[ -n "$note" ]] && printf "  %s" "$note"', $wrapperSource);
    }

    public function testWrapperAddsSparkFastnessMarkerInActiveLaneDisplay(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('quota_lane_display="${quota_lane_display} ⚡︎"', $wrapperSource);
        self::assertStringContainsString('quota_lane_display="${quota_lane_display} (fast)"', $wrapperSource);
        self::assertStringContainsString('if [[ "$quota_lane_label" == "spark" && -n "$CHATGPT_SPARK_LIMIT_NAME" ]]; then', $wrapperSource);
    }
}
