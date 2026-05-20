<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSummarySectionsTest extends TestCase
{
    public function testWrapperRendersSectionedSummaryRows(): void
    {
        $screenSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($screenSource, 'Expected to be able to read ui/screen.go');

        $bannerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/banner.go');
        self::assertIsString($bannerSource, 'Expected to be able to read ui/banner.go');

        // Boot screen renders the "Codex to Brrr!" tagline.
        self::assertStringContainsString('Codex to Brrr!', $screenSource);

        // PrintBootScreen and PrintBoot are the canonical entry points.
        self::assertStringContainsString('PrintBootScreen', $screenSource);
        self::assertStringContainsString('PrintBoot', $bannerSource);

        // Health dots: api, auth, skills, mcp are always emitted.
        $healthSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/health.go');
        self::assertIsString($healthSource, 'Expected to be able to read ui/health.go');
        self::assertStringContainsString('"api"', $healthSource);
        self::assertStringContainsString('"auth"', $healthSource);
        self::assertStringContainsString('"skills"', $healthSource);

        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read summary/summary.go');
        self::assertStringContainsString('{Name: "api"', $summarySource);
        self::assertStringContainsString('{Name: "auth"', $summarySource);
        self::assertStringContainsString('{Name: "skills"', $summarySource);
        self::assertStringContainsString('{Name: "mcp"', $summarySource);
    }

    public function testWrapperSupportsUpdatedHealthMarkers(): void
    {
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read summary/summary.go');

        // HealthDot.Updated flag drives the "updated this run" marker (⬆ vs ●).
        $healthSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/health.go');
        self::assertIsString($healthSource, 'Expected to be able to read ui/health.go');
        self::assertStringContainsString('Updated', $healthSource);
        self::assertStringContainsString('DotUp', $healthSource);

        // The wrapper tracks per-resource update flags.
        self::assertStringContainsString('AuthSynced', $summarySource);
        self::assertStringContainsString('SkillsUpdated', $summarySource);
        self::assertStringContainsString('ConfigUpdated', $summarySource);
        self::assertStringContainsString('AgentsUpdated', $summarySource);

        // Dots for auth, skills, mcp carry the Updated field.
        self::assertStringContainsString('Updated: in.AuthSynced', $summarySource);
        self::assertStringContainsString('Updated: in.SkillsUpdated', $summarySource);
        self::assertStringContainsString('Updated: in.ConfigUpdated', $summarySource);
    }

    public function testWrapperSuppressesBootScreenAfterSelfUpdateRestart(): void
    {
        $updateSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/update.go');
        self::assertIsString($updateSource, 'Expected to be able to read update/update.go');

        // The self-update path sets CODEX_WRAPPER_RESTARTED=1 before re-exec.
        self::assertStringContainsString('CODEX_WRAPPER_RESTARTED', $updateSource);
        self::assertStringContainsString('ReExecAfterUpdate', $updateSource);

        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        // The wrapper reads CODEX_WRAPPER_RESTART_DEPTH to guard against loops.
        self::assertStringContainsString('CODEX_WRAPPER_RESTART_DEPTH', $mainSource);
        self::assertStringContainsString('maxRestartDepth', $mainSource);
    }

    public function testWrapperUsesReadableUsageLabels(): void
    {
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read summary/summary.go');

        // Quota rows use human-readable labels: "5h" and "weekly".
        self::assertStringContainsString('"5h', $summarySource);
        self::assertStringContainsString('"weekly', $summarySource);

        // API calls and tokens this month are rendered on the boot screen.
        $screenSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($screenSource, 'Expected to be able to read ui/screen.go');
        self::assertStringContainsString('APICalls', $screenSource);
        self::assertStringContainsString('TokenSum', $screenSource);
        self::assertStringContainsString('tokens', $screenSource);
        self::assertStringContainsString('calls', $screenSource);
    }

    public function testWrapperKeepsQuotaWarnCopyCompact(): void
    {
        $summarySource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/summary/summary.go');
        self::assertIsString($summarySource, 'Expected to be able to read summary/summary.go');

        // Quota warn/block messages use compact copy.
        self::assertStringContainsString('quota reached', $summarySource);
        self::assertStringContainsString('quota high', $summarySource);
        self::assertStringContainsString('warnText', $summarySource);
        self::assertStringContainsString('blockText', $summarySource);
        self::assertStringContainsString('QuotaWarn', $summarySource);
        self::assertStringContainsString('QuotaBlock', $summarySource);

        // Legacy verbose phrases removed.
        self::assertStringNotContainsString('daily allowance reached', $summarySource);
        self::assertStringNotContainsString('ChatGPT quota reached', $summarySource);
    }

    public function testWrapperMeasuresBannerWidthInsteadOfUsingFixedFloatingOffset(): void
    {
        $bannerSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/banner.go');
        self::assertIsString($bannerSource, 'Expected to be able to read ui/banner.go');

        // Banner layout uses VisibleWidth() to measure art, not a fixed pad.
        self::assertStringContainsString('VisibleWidth', $bannerSource);
        self::assertStringContainsString('artWidth', $bannerSource);

        // No hard-coded 36-col pad.
        self::assertStringNotContainsString('art_pad=36', $bannerSource);
    }
}
