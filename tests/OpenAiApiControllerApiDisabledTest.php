<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class OpenAiApiControllerApiDisabledTest extends TestCase
{
    public function testControllerTakesVersionRepositoryAndCallsEnsureApiEnabled(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/OpenAiApiController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('use App\\Repositories\\VersionRepository;', $controller);
        self::assertStringContainsString('private readonly ?VersionRepository $versionRepository = null', $controller);
        self::assertStringContainsString("'openai_api_disabled'", $controller);
        self::assertStringContainsString('OpenAI API is currently disabled by administrator', $controller);
    }

    public function testAllMutatingHandlersEnforceEnabledFlag(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/OpenAiApiController.php');
        self::assertIsString($controller);

        // Every endpoint that accepts a payload or returns models must call ensureApiEnabled
        // for symmetry with the Anthropic controller.
        foreach (['chatCompletions', 'responses', 'completions', 'embeddings', 'models'] as $method) {
            $re = sprintf('/function %s\\(.*?ensureApiEnabled\\(\\).*?ensureBackend\\(\\)/s', preg_quote($method, '/'));
            self::assertMatchesRegularExpression($re, $controller, "Method {$method} must call ensureApiEnabled()");
        }
    }

    public function testIndexPhpWiresVersionRepositoryIntoController(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString('new OpenAiApiController($openaiBackend, $openaiKeyService, $rateLimiter, $openaiModelService, $versionRepository)', $router);
    }
}
