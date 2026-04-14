<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Both /v1/models and /anthropic/v1/models must enforce per-API-key rate limits
 * so automated clients cannot abuse them as an authentication oracle.
 */
final class ApiModelsRateLimitTest extends TestCase
{
    public function testOpenAiModelsEnforcesRateLimit(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/OpenAiApiController.php');
        self::assertIsString($controller);

        self::assertMatchesRegularExpression(
            '/public function models\\(\\).*?\\$this->enforceRateLimit\\(\\$key\\)/s',
            $controller,
            'Expected /v1/models to enforce rate limit.'
        );
    }

    public function testClaudeModelsEnforcesRateLimit(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/ClaudeApiController.php');
        self::assertIsString($controller);

        self::assertMatchesRegularExpression(
            '/public function models\\(\\).*?\\$this->enforceRateLimit\\(\\$key\\)/s',
            $controller,
            'Expected /anthropic/v1/models to enforce rate limit.'
        );
    }

    public function testClaudeEmbeddingsEnforcesRateLimit(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/ClaudeApiController.php');
        self::assertIsString($controller);

        self::assertMatchesRegularExpression(
            '/public function embeddings\\(array \\$payload\\).*?\\$this->enforceRateLimit\\(\\$key\\)/s',
            $controller
        );
    }
}
