<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class StartupSyncRoutesTest extends TestCase
{
    public function testRouterDefinesStartupSyncEndpoints(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($source);
        self::assertStringContainsString("#^/sync/status$#", $source);
        self::assertStringContainsString("#^/sync/bootstrap$#", $source);
    }

    public function testGoBinariesHandleStartupSync(): void
    {
        // The wrapper bakery v2 cutover moved the bash wrapper logic into Go.
        // The Codex lifecycle calls /auth, /sync/status, /agents/retrieve, and
        // /config/retrieve from wrappers/cdx/internal/lifecycle/run.go.
        $lifecycle = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycle, 'wrappers/cdx/internal/lifecycle/run.go missing');
        self::assertStringContainsString('client.AuthRetrieve', $lifecycle);
        self::assertStringContainsString('client.RetrieveAgents', $lifecycle);
        self::assertStringContainsString('client.RetrieveConfig', $lifecycle);
    }
}
