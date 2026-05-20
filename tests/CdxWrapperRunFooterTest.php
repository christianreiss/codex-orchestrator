<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRunFooterTest extends TestCase
{
    private static function readGoFile(string $relPath): string
    {
        $path = __DIR__ . '/../' . $relPath;
        $source = @file_get_contents($path);
        self::assertIsString($source, "Expected to be able to read {$relPath}");
        return $source;
    }

    public function testWrapperUsesCompactRunFooterSections(): void
    {
        // The Go wrapper uses PrintExitFooter() in ui/footer.go which renders
        // a "Run usage" row and a "Sync" row — the direct equivalents of the
        // bash wrapper's usage_label / sync_label variables.
        $footerSource = self::readGoFile('wrappers/cdx/internal/ui/footer.go');
        self::assertStringContainsString('PrintExitFooter', $footerSource);
        self::assertStringContainsString('Run usage', $footerSource);
        self::assertStringContainsString('Sync', $footerSource);

        // lifecycle/run.go calls PrintExitFooter and passes both UsageStatus and
        // AuthStatus — the Go equivalents of summary_row "$usage_label" and
        // summary_row "$sync_label".
        $lifecycleSource = self::readGoFile('wrappers/cdx/internal/lifecycle/run.go');
        self::assertStringContainsString('PrintExitFooter', $lifecycleSource);
        self::assertStringContainsString('UsageStatus', $lifecycleSource);
        self::assertStringContainsString('AuthStatus', $lifecycleSource);
    }

    public function testWrapperSuppressesFooterForEmptyRunsWithoutUsagePayload(): void
    {
        // The Go wrapper skips the per-token detail when no tokens were captured
        // and reports "uploaded (no tokens detected)" instead of a full usage line,
        // matching the bash wrapper's should_suppress_empty_run_footer logic.
        $lifecycleSource = self::readGoFile('wrappers/cdx/internal/lifecycle/run.go');
        self::assertStringContainsString('tokens.IsZero()', $lifecycleSource);
        self::assertStringContainsString('uploaded (no tokens detected)', $lifecycleSource);

        // The footer struct's Tokens field is nil when no usage was captured,
        // and PrintExitFooter skips the Run-usage row in that case.
        $footerSource = self::readGoFile('wrappers/cdx/internal/ui/footer.go');
        self::assertStringContainsString('f.Tokens != nil', $footerSource);
    }

    public function testWrapperRemovesLegacyPushFooterLines(): void
    {
        // The Go wrapper has no inline push-result footer strings; push outcomes
        // are encoded in the UsageStatus / AuthStatus fields passed to
        // PrintExitFooter, not printed as raw literal lines.
        $footerSource = self::readGoFile('wrappers/cdx/internal/ui/footer.go');
        self::assertStringNotContainsString('Usage push | ok |', $footerSource);
        self::assertStringNotContainsString('Usage push | ok (fallback) |', $footerSource);
        self::assertStringNotContainsString('Usage push | failed |', $footerSource);
        self::assertStringNotContainsString('Auth push | ${AUTH_PUSH_RESULT}', $footerSource);

        $lifecycleSource = self::readGoFile('wrappers/cdx/internal/lifecycle/run.go');
        self::assertStringNotContainsString('Usage push | ok |', $lifecycleSource);
        self::assertStringNotContainsString('Auth push | ${AUTH_PUSH_RESULT}', $lifecycleSource);
    }

    public function testWrapperDoesNotRenderBillingFooter(): void
    {
        // The Go wrapper has no cost/billing footer.  These strings must not
        // appear anywhere in the footer or lifecycle source.
        $footerSource = self::readGoFile('wrappers/cdx/internal/ui/footer.go');
        $lifecycleSource = self::readGoFile('wrappers/cdx/internal/lifecycle/run.go');

        $legacyFormatter = 'format_run_' . 'co' . 'st_value';
        $legacyLabel     = 'co' . 'st_label';
        $legacyEnv       = 'USAGE_PUSH_' . 'CO' . 'ST';

        self::assertStringNotContainsString($legacyFormatter, $footerSource);
        self::assertStringNotContainsString($legacyLabel,     $footerSource);
        self::assertStringNotContainsString($legacyEnv,       $footerSource);

        self::assertStringNotContainsString($legacyFormatter, $lifecycleSource);
        self::assertStringNotContainsString($legacyLabel,     $lifecycleSource);
        self::assertStringNotContainsString($legacyEnv,       $lifecycleSource);
    }
}
