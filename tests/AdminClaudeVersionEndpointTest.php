<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminClaudeVersionEndpointTest extends TestCase
{
    public function testGetAndPostVersionEndpointsAreRegistered(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString("#^/admin/claude/version$#", $router);
        self::assertStringContainsString("getClaudeVersion", $router);
        self::assertStringContainsString("postClaudeVersion", $router);
    }

    public function testVersionEndpointPersistsFleetVersionAndLockFlag(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("claude_fleet_version", $controller);
        self::assertStringContainsString("claude_version_locked", $controller);
        self::assertStringContainsString("claude_fleet_version_updated_at", $controller);
    }

    public function testSettingsEndpointGatesBehindSettingsCapability(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        // POST must require the settings capability — matches the Codex side.
        self::assertMatchesRegularExpression(
            '/public function postClaudeVersion.*?requireAdminCapability\s*\(\s*AdminAuthService::CAP_SETTINGS\s*\)/s',
            $controller
        );
    }
}
