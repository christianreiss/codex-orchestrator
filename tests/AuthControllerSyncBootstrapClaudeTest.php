<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AuthControllerSyncBootstrapClaudeTest extends TestCase
{
    public function testBootstrapAttachesClaudeUsageInsteadOfChatGptForClaudeHosts(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AuthController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('attachEngineUsage', $controller);
        self::assertStringContainsString("\$engine === Engine::CLAUDE", $controller);
        self::assertStringContainsString("\$result['claude_usage']", $controller);
        self::assertStringContainsString("\$result['chatgpt_usage']", $controller);
    }

    public function testBootstrapPassesEngineThroughStartupSyncService(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AuthController.php');
        self::assertIsString($controller);

        self::assertMatchesRegularExpression(
            '/syncBootstrap.*?\\$this->startupSyncService->collect\\(.*?\\$engine\\)/s',
            $controller
        );
    }

    public function testClaudeUsageServiceIsOptionalConstructorArg(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AuthController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('private ?ClaudeUsageService $claudeUsageService = null', $controller);
    }

    public function testIndexPhpWiresClaudeUsageService(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString('$claudeUsageService', $router);
        self::assertStringContainsString('new AuthController($service, $chatGptUsageService, $startupSyncService, $versionRepository, $claudeUsageService)', $router);
    }
}
