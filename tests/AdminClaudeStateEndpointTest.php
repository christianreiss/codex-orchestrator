<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminClaudeStateEndpointTest extends TestCase
{
    public function testRoutesAreRegistered(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString("#^/admin/claude/state$#", $router);
        self::assertStringContainsString("getClaudeApiState", $router);
        self::assertStringContainsString("postClaudeApiState", $router);
    }

    public function testStateFlagsUseClaudeApiDisabledVersionKey(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("'claude_api_disabled'", $controller);
    }

    public function testRouteDispatcherGatesAnthropicTrafficOnDisableFlag(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        // /anthropic/v1/* requests should 503 when claude_api_disabled is true.
        self::assertMatchesRegularExpression(
            "/str_starts_with\\(\\\$normalizedPath, '\\/anthropic\\/v1\\/'\\).*?claude_api_disabled/s",
            $router
        );
    }
}
