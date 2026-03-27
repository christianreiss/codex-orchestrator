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
