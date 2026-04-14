<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminClaudeKeyControllerTest extends TestCase
{
    public function testIndexFiltersByClaudeEngine(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminClaudeKeyController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('listByEngine(Engine::CLAUDE)', $controller);
    }

    public function testMutatingHandlersPassClaudeEngineArgument(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminClaudeKeyController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('generate($name, $adminUserId, $rateLimitRpm, $expiresAt, Engine::CLAUDE)', $controller);
        self::assertStringContainsString('toggleActive((int) $id, $active, Engine::CLAUDE)', $controller);
        self::assertStringContainsString('delete((int) $id, Engine::CLAUDE)', $controller);
    }

    public function testRoutesAreRegistered(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString("#^/admin/claude/keys$#", $router);
        self::assertStringContainsString("#^/admin/claude/keys/(\\d+)/toggle$#", $router);
        self::assertStringContainsString("#^/admin/claude/keys/(\\d+)$#", $router);
    }
}
