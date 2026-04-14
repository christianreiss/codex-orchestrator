<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperStartupBundleTest extends TestCase
{
    public function testBundleFragmentPostsToSyncBootstrapEndpoint(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-40-startup-bundle.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('/sync/bootstrap', $fragment);
        // jq wires `engine: $engine` with --arg engine "claude".
        self::assertStringContainsString('--arg engine "claude"', $fragment);
        self::assertStringContainsString('engine: $engine', $fragment);
        self::assertStringContainsString('include_auth: $include_auth', $fragment);
        self::assertStringContainsString('CLX_STARTUP_BUNDLE_STATUS', $fragment);
    }

    public function testBundleRespectsEndpointMissingAndFallsBack(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-40-startup-bundle.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('endpoint-missing', $fragment);
        self::assertStringContainsString('http-${http_code}', $fragment);
    }

    public function testBundleIsGatedOffByDefault(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-40-startup-bundle.sh');
        self::assertIsString($fragment);
        // Default is 0 (disabled) until the endpoint has been proven in Claude mode.
        self::assertStringContainsString('CLX_USE_STARTUP_BUNDLE="${CLX_USE_STARTUP_BUNDLE:-0}"', $fragment);
    }

    public function testBootstrapOrchestratorSkipsPerPhaseWhenBundleSucceeded(): void
    {
        $bootstrap = file_get_contents(__DIR__ . '/../bin/clx.d/05-main-10-bootstrap.sh');
        self::assertIsString($bootstrap);

        self::assertStringContainsString('if clx_startup_bundle_enabled; then', $bootstrap);
        self::assertStringContainsString('bundle_ok=1', $bootstrap);
        self::assertStringContainsString('if (( bundle_ok == 0 )); then', $bootstrap);
        self::assertStringContainsString('clx_sync_agents', $bootstrap);
        self::assertStringContainsString('clx_sync_config', $bootstrap);
    }
}
