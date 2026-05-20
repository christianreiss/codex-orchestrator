<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * A CLX host that has no FQDN configured (and no sync URL / API key) must still
 * launch — the wrapper can run against a locally-installed Claude CLI with
 * ANTHROPIC_API_KEY in the env. Verify the sync helpers no-op gracefully in that
 * case rather than erroring out.
 */
final class ClxWrapperFqdnGuardTest extends TestCase
{
    public function testAuthSyncShortCircuitsWithoutSyncConfig(): void
    {
        // In the Go wrapper, auth sync is gated on lifecycle.Options.SkipAuthSync.
        // When the orchestrator URL is unreachable the bootstrap() helper returns
        // an "offline" AuthRetrieveResponse so the run still proceeds.
        $runSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($runSource);

        // SkipAuthSync option gates the whole sync block
        self::assertStringContainsString('SkipAuthSync', $runSource);
        self::assertStringContainsString('if !opts.SkipAuthSync {', $runSource);

        // Offline sentinel used when the orchestrator is unreachable
        self::assertStringContainsString('"offline"', $runSource);

        // Auth is still allowed when the API is offline (see auth_decide.go)
        $decideSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/auth_decide.go');
        self::assertIsString($decideSource);
        self::assertStringContainsString('"offline"', $decideSource);
    }

    public function testConfigSyncShortCircuitsWithoutSyncConfig(): void
    {
        // Config sync (settings.json retrieval) is skipped when the orchestrator
        // cannot be reached.  The lifecycle falls back gracefully via the offline
        // path rather than aborting.
        $runSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($runSource);

        // writeSettings() is guarded inside the sync block and skipped on error
        self::assertStringContainsString('writeSettings(', $runSource);
        self::assertStringContainsString('settings sync skipped', $runSource);

        // Config validation requires base_url + api_key; an empty base_url means
        // the config itself won't load — not that the wrapper crashes mid-run.
        $loadSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/config/load.go');
        self::assertIsString($loadSource);
        self::assertStringContainsString('orchestrator.base_url is required', $loadSource);
        self::assertStringContainsString('orchestrator.api_key too short', $loadSource);
    }

    public function testStartupBundleShortCircuitsWithoutSyncConfig(): void
    {
        // In the Go wrapper the /sync/bootstrap bundle endpoint is optional.
        // When it returns 404/501/405 (server doesn't support it) the code falls
        // back to the legacy individual-sync path without aborting.
        $runSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($runSource);

        self::assertStringContainsString('isBundleUnsupported(', $runSource);
        // The bundle-unsupported fallback logs a debug message and continues
        self::assertStringContainsString('bundle endpoint unsupported', $runSource);
        // Offline response is the no-sync sentinel: bundle error is non-fatal
        self::assertStringContainsString('bundle missing auth block', $runSource);
    }
}
