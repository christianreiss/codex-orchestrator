<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureApprovalBoxFormatTest extends TestCase
{
    public function testWrapperBuildsPendingApprovalBoxWithBorderAwareWidthCalculation(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'content_width=$min_content_width',
            $wrapperSource,
            'Pending approval box should start from a stable minimum width.'
        );
        self::assertStringContainsString(
            'printf \'%b%s%s%s%b\\n\' "${CYAN}${BOLD}" "$top_left" "$(repeat_box_char "$horizontal" $((content_width + 2)))" "$top_right" "$RESET"',
            $wrapperSource,
            'Top border width should account for the content width plus side padding.'
        );
        self::assertStringContainsString(
            'printf \'%b%s%b %s%*s %b%s%b\\n\' "${CYAN}${BOLD}" "$vertical" "$RESET" "$st" "$pad" "" "${CYAN}${BOLD}" "$vertical" "$RESET"',
            $wrapperSource,
            'Content rows should use fixed-width padding so the right border stays aligned.'
        );
        self::assertStringContainsString(
            'printf \'%b%s%s%s%b\' "${CYAN}${BOLD}" "$bottom_left" "$(repeat_box_char "$horizontal" $((content_width + 2)))" "$bottom_right" "$RESET"',
            $wrapperSource,
            'Bottom border width should match the top border.'
        );
    }

    public function testWrapperFallsBackToAsciiBordersForDumbTerminals(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if ((CODEX_TERM_IS_DUMB)); then',
            $wrapperSource
        );
        self::assertStringContainsString(
            'top_left="+"',
            $wrapperSource
        );
        self::assertStringContainsString(
            'horizontal="-"',
            $wrapperSource
        );
        self::assertStringContainsString(
            'vertical="|"',
            $wrapperSource
        );
    }
}
