<?php

use PHPUnit\Framework\TestCase;

final class AdminHostClaudeVersionEndpointTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("#^/admin/hosts/(\\d+)/claude-version$#", $routerSource);
    }

    public function testHostListIncludesClaudeVersionOverrideField(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php')
            . file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        self::assertIsString($source);

        self::assertStringContainsString("'claude_client_version_override'", $source);
    }

    public function testEndpointUsesClaudeVersionPolicy(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php')
            . file_get_contents(__DIR__ . '/../src/Services/ClientVersionService.php');
        self::assertIsString($source);

        self::assertStringContainsString('ClaudeVersionPolicy::isSemanticVersion', $source);
        self::assertStringContainsString('ClaudeVersionPolicy::resolveEffective($override, true)', $source);
    }
}
