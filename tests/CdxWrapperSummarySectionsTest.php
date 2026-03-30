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
}
