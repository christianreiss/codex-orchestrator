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
        self::assertStringContainsString('summary_row "$usage_label" "$usage_text"', $wrapperSource);
        self::assertStringContainsString('summary_row "$sync_label" "$sync_text"', $wrapperSource);
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

    public function testWrapperDoesNotRenderBillingFooter(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $legacyFormatter = 'format_run_' . 'co' . 'st_value() {';
        $legacyLabel = 'co' . 'st_label="Run ' . 'co' . 'st"';
        $legacyEnv = 'USAGE_PUSH_' . 'CO' . 'ST';

        self::assertStringNotContainsString($legacyFormatter, $wrapperSource);
        self::assertStringNotContainsString($legacyLabel, $wrapperSource);
        self::assertStringNotContainsString($legacyEnv, $wrapperSource);
    }
}
