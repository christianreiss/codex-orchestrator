<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperQuotaSummarySplitTest extends TestCase
{
    public function testWrapperUsesDedicatedOtherLaneQuotaBars(): void
    {
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read wrappers/cdx/internal/summary/summary.go');

        // Spark and normal lane rows are added separately via distinct addRow calls
        self::assertStringContainsString('"spark"', $summarySource);
        self::assertStringContainsString('"normal"', $summarySource);
        // SparkPrimaryUsed and SparkSecondaryUsed are dedicated fields (not combined string)
        self::assertStringContainsString('q.SparkPrimaryUsed', $summarySource);
        self::assertStringContainsString('q.SparkSecondaryUsed', $summarySource);
        // Normal lane primary and secondary used
        self::assertStringContainsString('q.PrimaryUsed', $summarySource);
        self::assertStringContainsString('q.SecondaryUsed', $summarySource);
        // The old combined-string format is gone
        self::assertStringNotContainsString('Spark: 5h ${spark_5h}, week ${spark_wk}', $summarySource);
    }

    public function testWrapperAlignsQuotaGraphRowsUsingSharedMetricFormatter(): void
    {
        $quotaSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/quota.go');
        self::assertIsString($quotaSource, 'Expected to be able to read wrappers/cdx/internal/ui/quota.go');

        // PrintQuotaRow is the shared formatter for all quota bars
        self::assertStringContainsString('func PrintQuotaRow(', $quotaSource);
        // Row struct carries a Label, Used percentage, and Note/Projection
        self::assertStringContainsString('Label', $quotaSource);
        self::assertStringContainsString('Note', $quotaSource);
        self::assertStringContainsString('Projection', $quotaSource);
        // PadRight is used to align labels
        self::assertStringContainsString('PadRight(', $quotaSource);
        // Note/Projection is printed after the bar
        self::assertStringContainsString('if note != ""', $quotaSource);
    }

    public function testWrapperUsesHumanWeeklyHitEstimateWhenProjectionReachesReset(): void
    {
        $quotaSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/quota.go');
        self::assertIsString($quotaSource, 'Expected to be able to read wrappers/cdx/internal/ui/quota.go');

        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read wrappers/cdx/internal/summary/summary.go');

        // ProjectETA returns time-to-100% at current burn rate
        self::assertStringContainsString('func ProjectETA(', $quotaSource);
        // Projection note uses "~100% in … before reset" phrasing
        self::assertStringContainsString('~100%%', $summarySource);
        self::assertStringContainsString('before reset', $summarySource);
        // ETA is stored on the QuotaRow as Projection
        self::assertStringContainsString('row.Projection =', $summarySource);
        // ProjectETA is called in summary.go
        self::assertStringContainsString('ui.ProjectETA(', $summarySource);
    }

    public function testWrapperAddsSparkFastnessMarkerInActiveLaneDisplay(): void
    {
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read wrappers/cdx/internal/summary/summary.go');

        // Spark rows carry "spark" in their Lane field
        self::assertStringContainsString('"spark"', $summarySource);
        // Spark quota rows use the ⚡ prefix in their labels
        self::assertStringContainsString('⚡', $summarySource);
    }
}
