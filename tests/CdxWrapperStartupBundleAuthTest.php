<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperStartupBundleAuthTest extends TestCase
{
    public function testWrapperUsesStartupBundleForAuthWhenLocalAuthIsAlreadyValid(): void
    {
        // The Go wrapper uses /sync/bootstrap (SyncBootstrap) as the fast path
        // that returns auth + agents + config in a single round-trip.
        $bundleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/orchestrator/bundle.go');
        self::assertIsString($bundleSource, 'Expected to be able to read bundle.go');

        // BundleRequest carries IncludeAuth — mirrors legacy CODEX_SYNC_INCLUDE_AUTH.
        self::assertStringContainsString('IncludeAuth', $bundleSource);
        self::assertStringContainsString('"include_auth"', $bundleSource);
        self::assertStringContainsString('AuthCandidate', $bundleSource);
        self::assertStringContainsString('"auth_candidate,omitempty"', $bundleSource);
        self::assertStringContainsString('SyncBootstrap', $bundleSource);
        self::assertStringContainsString('/sync/bootstrap', $bundleSource);

        $lifecycleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycleSource, 'Expected to be able to read lifecycle/run.go');

        // bootstrap() sends auth digest + candidate up-front (mirrors legacy bundle auth logic).
        self::assertStringContainsString('IncludeAuth:   true', $lifecycleSource);
        self::assertStringContainsString('AuthDigest:', $lifecycleSource);
        self::assertStringContainsString('AuthCandidate:', $lifecycleSource);
        self::assertStringContainsString('authSynced', $lifecycleSource);
    }

    public function testWrapperKeepsLegacyAuthPullAsFallbackWhenBundleAuthCannotBeUsed(): void
    {
        $lifecycleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycleSource, 'Expected to be able to read lifecycle/run.go');

        // When the bundle endpoint returns 404/501 the wrapper falls back to
        // per-resource sync (legacySyncPath / syncAuthLegacy).
        self::assertStringContainsString('isBundleUnsupported', $lifecycleSource);
        self::assertStringContainsString('legacySyncPath', $lifecycleSource);
        self::assertStringContainsString('syncAuthLegacy', $lifecycleSource);
        self::assertStringContainsString('-> 404', $lifecycleSource);
    }
}
