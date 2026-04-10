<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClaudeApiCompatibilityTest extends TestCase
{
    private static string $routerSource = '';
    private static string $adminSource = '';
    private static string $apiDocSource = '';

    public static function setUpBeforeClass(): void
    {
        self::$routerSource = (string) file_get_contents(__DIR__ . '/../public/index.php');
        self::$adminSource = (string) file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::$apiDocSource = (string) file_get_contents(__DIR__ . '/../docs/interface-api.md');
    }

    public function testRouterSourceContainsAnthropicMessagesRoute(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/messages',
            self::$routerSource,
            'Router should define the Anthropic /anthropic/v1/messages route'
        );
    }

    public function testRouterSourceContainsAnthropicModelsRoute(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/models',
            self::$routerSource,
            'Router should define the Anthropic /anthropic/v1/models route'
        );
    }

    public function testRouterSourceContainsAnthropicCompletionsRoute(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/completions',
            self::$routerSource,
            'Router should define the Anthropic /anthropic/v1/completions route'
        );
    }

    public function testAdminHtmlContainsClaudeSettingsPanel(): void
    {
        $lower = strtolower(self::$adminSource);
        $this->assertTrue(
            str_contains($lower, 'claude') || str_contains($lower, 'anthropic'),
            'Admin HTML should contain a Claude or Anthropic settings panel'
        );
    }

    public function testApiDocsContainAnthropicMessagesDocumentation(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/messages',
            self::$apiDocSource,
            'API docs should document the /anthropic/v1/messages endpoint'
        );
    }

    public function testApiDocsContainAnthropicCompletionsDocumentation(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/completions',
            self::$apiDocSource,
            'API docs should document the /anthropic/v1/completions endpoint'
        );
    }

    public function testStreamingEventsMatchAnthropicFormat(): void
    {
        if (!class_exists(\App\Http\AnthropicCompat::class)) {
            $this->markTestSkipped('AnthropicCompat class not yet available');
        }

        if (!method_exists(\App\Http\AnthropicCompat::class, 'messageStreamEvents')) {
            $this->markTestSkipped('messageStreamEvents not yet implemented');
        }

        $events = \App\Http\AnthropicCompat::messageStreamEvents([
            'id' => 'msg_test',
            'type' => 'message',
            'role' => 'assistant',
            'model' => 'claude-sonnet-4-20250514',
            'content' => [
                ['type' => 'text', 'text' => 'Hello'],
            ],
            'usage' => [
                'input_tokens' => 10,
                'output_tokens' => 5,
            ],
        ]);

        $this->assertIsArray($events);

        $expectedTypes = [
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop',
        ];

        $actualTypes = array_map(
            static fn(array $e): string => $e['type'] ?? '',
            $events
        );

        foreach ($expectedTypes as $expectedType) {
            $this->assertContains(
                $expectedType,
                $actualTypes,
                "Streaming events should include '{$expectedType}'"
            );
        }
    }

    public function testAnthropicCompatClassExists(): void
    {
        $this->assertTrue(
            class_exists(\App\Http\AnthropicCompat::class),
            'AnthropicCompat class should exist at App\Http\AnthropicCompat'
        );
    }

    public function testClaudeBackendAdapterClassExists(): void
    {
        $this->assertTrue(
            class_exists(\App\Adapters\ClaudeBackendAdapter::class),
            'ClaudeBackendAdapter class should exist at App\Adapters\ClaudeBackendAdapter'
        );
    }

    public function testClaudeModelServiceClassExists(): void
    {
        $this->assertTrue(
            class_exists(\App\Services\ClaudeModelService::class),
            'ClaudeModelService class should exist at App\Services\ClaudeModelService'
        );
    }

    public function testClaudeUsageServiceClassExists(): void
    {
        $this->assertTrue(
            class_exists(\App\Services\ClaudeUsageService::class),
            'ClaudeUsageService class should exist at App\Services\ClaudeUsageService'
        );
    }
}
