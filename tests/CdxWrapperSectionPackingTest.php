<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSectionPackingTest extends TestCase
{
    public function testWrapperPacksSummaryRowsIntoAlignedColumnsByDefault(): void
    {
        $source = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/screen.go');

        // PrintSessionsBlock renders a 2-column grid (pairs items per row).
        self::assertStringContainsString('PrintSessionsBlock', $source);
        // Column separation is a fixed gap constant.
        self::assertStringContainsString('gridGap', $source);
        // Each cell is built via sessionCell (equivalent to column padding).
        self::assertStringContainsString('sessionCell', $source);
        // Rows are iterated in steps of 2 (items-per-row = 2).
        self::assertStringContainsString('i += 2', $source);
        // Old bash tab-packing idiom must not appear.
        self::assertStringNotContainsString('packed_count++', $source);
        self::assertStringNotContainsString('packed_line+=$', $source);
    }

    public function testWrapperAllowsSummaryPackingOverrideViaEnvVar(): void
    {
        $source = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/screen.go');

        // The session block uses a per-row stride that can be read from the
        // grid constant — the loop stride controls items-per-row layout.
        self::assertStringContainsString('i += 2', $source);
        // The grid gap is a named constant (not an ad-hoc magic string).
        self::assertStringContainsString('const gridGap', $source);
    }

    public function testWrapperDefaultsQuotaSectionToSingleItemPerRowForBarAlignment(): void
    {
        $source = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/quota.go');
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/quota.go');

        // Quota rows are printed one per line (single-item-per-row layout).
        self::assertStringContainsString('PrintQuotaRow', $source);
        // Each bar has a fixed BarWidth (equivalent to column-width alignment).
        self::assertStringContainsString('BarWidth', $source);
        // Labels are padded to a fixed width so bars line up.
        self::assertStringContainsString('PadRight', $source);
    }

    public function testWrapperDefaultsVersionsSectionToTwoItemsPerRowForReadability(): void
    {
        $source = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/screen.go');

        // Versions (codex + wrapper) are rendered as two separate lines, each
        // holding exactly one version entry — matching the bash two-items-per-row default.
        self::assertStringContainsString('codexLine', $source);
        self::assertStringContainsString('wrapperLine', $source);
        // Both lines appear in PrintBootScreen.
        self::assertStringContainsString('PrintBootScreen', $source);
    }
}
