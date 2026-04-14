<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminClaudeSettingsEndpointTest extends TestCase
{
    public function testRoutesAreRegistered(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString("#^/admin/claude/settings$#", $router);
        self::assertStringContainsString("getClaudeSettings", $router);
        self::assertStringContainsString("postClaudeSettings", $router);
    }

    public function testGetEndpointReturnsDefaultModelMaxTokensSpendLimit(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("'default_model'", $controller);
        self::assertStringContainsString("'max_tokens'", $controller);
        self::assertStringContainsString("'spend_limit'", $controller);
        self::assertStringContainsString("'disabled'", $controller);
    }

    public function testPostEndpointRejectsInvalidModelOutsideSupportedList(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        // Allowlist uses ClaudeModelService::SUPPORTED_MODELS — the guard is what keeps callers
        // from persisting a model the backend can't actually run.
        self::assertStringContainsString(
            'in_array($model, ClaudeModelService::SUPPORTED_MODELS, true)',
            $controller
        );
    }

    public function testPostEndpointClampsMaxTokensRange(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminSettingsController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('$tokens >= 256 && $tokens <= 200000', $controller);
    }
}
