<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminOpenAiKeyEngineFilterTest extends TestCase
{
    public function testIndexIsEngineFilteredToCodex(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOpenAiKeyController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('listByEngine(Engine::CODEX)', $controller);
        self::assertStringNotContainsString('$this->keyService->list();', $controller);
    }

    public function testToggleAndDeletePassCodexEngineArgument(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOpenAiKeyController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('toggleActive((int) $id, $active, Engine::CODEX)', $controller);
        self::assertStringContainsString('delete((int) $id, Engine::CODEX)', $controller);
        self::assertStringContainsString('generate($name, $adminUserId, $rateLimitRpm, $expiresAt, Engine::CODEX)', $controller);
    }
}
