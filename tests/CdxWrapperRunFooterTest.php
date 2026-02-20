<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRunFooterTest extends TestCase
{
    public function testWrapperUsesCompactRunFooterSections(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('print_run_exit_footer() {', $wrapperSource);
        self::assertStringContainsString('usage_label="Run usage"', $wrapperSource);
        self::assertStringContainsString('sync_label="Sync"', $wrapperSource);
        self::assertStringContainsString('format_simple_row "$usage_label" "$usage_text"', $wrapperSource);
        self::assertStringContainsString('format_simple_row "$cost_label" "$cost_text"', $wrapperSource);
        self::assertStringContainsString('format_simple_row "$sync_label" "$sync_text"', $wrapperSource);
        self::assertStringContainsString('print_run_exit_footer || true', $wrapperSource);
    }

    public function testWrapperRemovesLegacyPushFooterLines(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringNotContainsString('Usage push | ok |', $wrapperSource);
        self::assertStringNotContainsString('Usage push | ok (fallback) |', $wrapperSource);
        self::assertStringNotContainsString('Usage push | failed |', $wrapperSource);
        self::assertStringNotContainsString('Auth push | ${AUTH_PUSH_RESULT} | ${AUTH_PUSH_REASON:-n/a}', $wrapperSource);
    }

    public function testWrapperHasRunCostUnicodeAndAsciiLabels(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $moneyLabel = 'cost_label="' . "\u{1F4B0}" . ' Run cost"';
        self::assertStringContainsString($moneyLabel, $wrapperSource);
        self::assertStringContainsString('cost_label="Run cost"', $wrapperSource);
    }

    public function testWrapperFormatsRunCostWithTwoDecimalsAndCurrencySuffix(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('format_run_cost_value() {', $wrapperSource);
        self::assertStringContainsString('LC_NUMERIC=C printf "%.2f$" "$raw"', $wrapperSource);
        self::assertStringContainsString('cost_text="$(format_run_cost_value "${USAGE_PUSH_COST}")"', $wrapperSource);
    }
}
