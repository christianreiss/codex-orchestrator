<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSummarySectionsTest extends TestCase
{
    public function testWrapperRendersSectionedSummaryRows(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('print_boot_screen() {', $wrapperSource);
        self::assertStringContainsString('print_boot_banner "${info[@]}"', $wrapperSource);
        self::assertStringContainsString('Codex to Brrr!', $wrapperSource);
        self::assertStringContainsString('CODEX_ADMIN_THEME_DEFAULT="__CODEX_ADMIN_THEME__"', $wrapperSource);
        self::assertStringContainsString('banner_color_sequence()', $wrapperSource);
        self::assertStringContainsString('theme_is_pink()', $wrapperSource);
        self::assertStringContainsString('auto-pink', $wrapperSource);
        self::assertStringContainsString('build_health_dot "api"', $wrapperSource);
        self::assertStringContainsString('build_health_dot "auth"', $wrapperSource);
        self::assertStringContainsString('build_health_dot "skills"', $wrapperSource);
    }

    public function testWrapperSupportsUpdatedHealthMarkers(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('local name="$1" tone="$2" updated="${3:-0}"', $wrapperSource);
        self::assertStringContainsString('if [[ "$updated" == "1" ]]; then', $wrapperSource);
        self::assertStringContainsString('output_supports_unicode || marker="^"', $wrapperSource);
        self::assertStringContainsString('build_health_dot "auth" "${auth_tone:-yellow}" "${auth_updated_marker}"', $wrapperSource);
        self::assertStringContainsString('build_health_dot "skills" "${skill_tone:-green}" "${skills_updated_marker}"', $wrapperSource);
        self::assertStringContainsString('build_health_dot "mcp" "$mcp_tone" "${mcp_updated_marker}"', $wrapperSource);
        self::assertStringContainsString('if [[ "${AUTH_ACTION:-}" == "store" || "${AUTH_STATUS:-}" == "outdated" ]]; then', $wrapperSource);
        self::assertStringContainsString('if [[ "${CONFIG_SYNC_STATUS:-}" == "ok" && ( "${CONFIG_STATE:-}" == "updated" || "${CONFIG_STATE:-}" == "missing" ) ]]; then', $wrapperSource);
        self::assertStringContainsString('if [[ "${RUNNER_ENABLED:-0}" == "1" && -n "${RUNNER_LAST_CHECK:-}" ]]; then', $wrapperSource);
        self::assertStringNotContainsString('if [[ "${SKILL_SYNC_STATUS:-}" == "mcp" ]]; then', $wrapperSource);
    }

    public function testWrapperSuppressesBootScreenAfterSelfUpdateRestart(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            '[[ "${CODEX_WRAPPER_RESTARTED:-0}" == "1" ]] && return 0',
            $wrapperSource,
            'Wrapper self-update re-execs should not print the boot screen a second time.'
        );
        self::assertStringContainsString('local tagline="   Codex to Brrr!"', $wrapperSource);
        self::assertStringContainsString('title="$(colorize "codex orchestrator" "$(banner_color_tone)")"', $wrapperSource);
    }

    public function testWrapperUsesReadableUsageLabels(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('API calls (host total)', $wrapperSource);
        self::assertStringContainsString('Tokens this month', $wrapperSource);
        self::assertStringContainsString('q_labels+=("5h")', $wrapperSource);
        self::assertStringContainsString('q_labels+=("weekly")', $wrapperSource);
    }

    public function testWrapperKeepsQuotaWarnCopyCompact(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('reason="daily budget hit (${daily_allowance_used_pct}%"', $wrapperSource);
        self::assertStringContainsString('note_parts+=("${daily_used}% of week today")', $wrapperSource);
        self::assertStringContainsString('note_parts+=("${allowance_per_day}%/day budget")', $wrapperSource);
        self::assertStringContainsString('log_warn "Quota warn mode; continuing."', $wrapperSource);
        self::assertStringNotContainsString('reason="daily allowance reached (${daily_allowance_used_pct}% of allowance"', $wrapperSource);
        self::assertStringNotContainsString('log_warn "ChatGPT quota reached: ${QUOTA_BLOCK_REASON:-see details above}. Continuing (warn mode)."', $wrapperSource);
    }

    public function testWrapperMeasuresBannerWidthInsteadOfUsingFixedFloatingOffset(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('local art_pad=0', $wrapperSource);
        self::assertStringContainsString('local gap="  "', $wrapperSource);
        self::assertStringContainsString('art_width="$(visible_text_width "$art_line")"', $wrapperSource);
        self::assertStringContainsString('art_len="$(visible_text_width "$art_line")"', $wrapperSource);
        self::assertStringNotContainsString('local art_pad=36', $wrapperSource);
        self::assertStringNotContainsString('local gap="   "', $wrapperSource);
    }
}
