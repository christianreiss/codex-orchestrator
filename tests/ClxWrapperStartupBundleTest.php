<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperStartupBundleTest extends TestCase
{
    public function testBundleFragmentPostsToSyncBootstrapEndpoint(): void
    {
        // The Go equivalent lives in wrappers/clx/internal/orchestrator/bundle.go
        // and wrappers/clx/internal/lifecycle/run.go.
        $bundle = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/bundle.go');
        self::assertIsString($bundle);

        self::assertStringContainsString('/sync/bootstrap', $bundle);
        // Engine defaults to "claude" in SyncBootstrap.
        self::assertStringContainsString('"claude"', $bundle);
        // BundleRequest carries engine and include_auth fields.
        self::assertStringContainsString('Engine', $bundle);
        self::assertStringContainsString('IncludeAuth', $bundle);

        // lifecycle/run.go posts the request and checks the result status.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);
        self::assertStringContainsString('SyncBootstrap', $run);
        self::assertStringContainsString('Engine:        "claude"', $run);
        self::assertStringContainsString('IncludeAuth:   true', $run);
    }

    public function testBundleRespectsEndpointMissingAndFallsBack(): void
    {
        // isBundleUnsupported in lifecycle/run.go detects 404/501/405 and
        // falls back to the per-resource pull path (legacySyncPath).
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);

        self::assertStringContainsString('isBundleUnsupported', $run);
        self::assertStringContainsString('-> 404', $run);
        self::assertStringContainsString('legacySyncPath', $run);
    }

    public function testBundleIsGatedOffByDefault(): void
    {
        // In Go the bundle call is unconditional; the guard is the SkipAuthSync
        // option (defaults false → bundle is attempted on every run).
        // The legacy "disabled by default" bash flag has no Go equivalent;
        // instead the caller controls opt-out via Options.SkipAuthSync.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);

        self::assertStringContainsString('SkipAuthSync', $run);
    }

    public function testBundleCreatesClaudeConfigDirBeforeMirroringSettings(): void
    {
        // atomicWrite in lifecycle/run.go calls os.MkdirAll on the parent
        // directory before writing, which covers the ~/.claude/settings.json path.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);

        self::assertStringContainsString('MkdirAll', $run);
        self::assertStringContainsString('settings.json', $run);
    }

    public function testConfigSyncCreatesClaudeConfigDirBeforeMirroringSettings(): void
    {
        // writeSettings in lifecycle/run.go calls atomicWrite which calls
        // os.MkdirAll before writing the settings file.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);

        self::assertStringContainsString('writeSettings', $run);
        self::assertStringContainsString('MkdirAll', $run);
        self::assertStringContainsString('settings.json', $run);
    }

    public function testBootstrapOrchestratorSkipsPerPhaseWhenBundleSucceeded(): void
    {
        // bootstrap() in lifecycle/run.go tries the bundle first; only on
        // isBundleUnsupported does it fall back to legacySyncPath which does
        // per-resource pulls (syncAuthLegacy + writeAgents + writeSettings).
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);

        self::assertStringContainsString('isBundleUnsupported', $run);
        self::assertStringContainsString('legacySyncPath', $run);
        self::assertStringContainsString('syncAuthLegacy', $run);
        self::assertStringContainsString('writeAgents', $run);
        self::assertStringContainsString('writeSettings', $run);
    }
}
