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

    public function testWrapperSuppressesFooterForEmptyRunsWithoutUsagePayload(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('should_suppress_empty_run_footer() {', $wrapperSource);
        self::assertStringContainsString('[[ -z "${USAGE_PUSH_SUMMARY:-}" ]] || return 1', $wrapperSource);
        self::assertStringContainsString('[[ -z "${last_usage_payload:-}" ]] || return 1', $wrapperSource);
        self::assertStringContainsString('[[ "${USAGE_PUSH_RESULT:-}" == "skipped" ]] || return 1', $wrapperSource);
        self::assertStringContainsString('[[ "${USAGE_PUSH_REASON:-}" == "no token usage captured" ]]', $wrapperSource);
        self::assertStringContainsString('if should_suppress_empty_run_footer; then', $wrapperSource);
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

    public function testWrapperKeepsRunCostLabelAsciiAndPrefixesUnicodeCostValue(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $moneyPrefix = 'cost_prefix="' . "\u{1F4B0}" . ' "';
        self::assertStringContainsString($moneyPrefix, $wrapperSource);
        self::assertStringContainsString('cost_label="Run cost"', $wrapperSource);
        self::assertStringContainsString('cost_text="${cost_prefix}unavailable (${cost_reason})"', $wrapperSource);
    }

    public function testWrapperFormatsRunCostWithCurrencyPrefixAndVariableDecimals(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('format_run_cost_value() {', $wrapperSource);
        // Dollar sign is now a prefix: printf '$%s' "$formatted"
        self::assertStringContainsString("printf '\$%s' \"\$formatted\"", $wrapperSource);
        // Sub-cent values use 4 decimal places; larger amounts use 2.
        self::assertStringContainsString('LC_NUMERIC=C printf "%.4f" "$raw"', $wrapperSource);
        self::assertStringContainsString('LC_NUMERIC=C printf "%.2f" "$raw"', $wrapperSource);
        self::assertStringContainsString('cost_text="${cost_prefix}$(format_run_cost_value "${USAGE_PUSH_COST}")"', $wrapperSource);
    }
}
