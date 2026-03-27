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

    public function testWrapperUsesBundledSyncWithLegacyFallback(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('sync_startup_bundle_pull()', $wrapperSource);
        self::assertStringContainsString('/sync/status', $wrapperSource);
        self::assertStringContainsString('/sync/bootstrap', $wrapperSource);
        self::assertStringContainsString('if ! sync_startup_bundle_pull; then', $wrapperSource);
        self::assertStringContainsString('sync_skills_pull || true', $wrapperSource);
        self::assertStringContainsString('sync_agents_pull || true', $wrapperSource);
        self::assertStringContainsString('sync_config_pull || true', $wrapperSource);
    }
}
