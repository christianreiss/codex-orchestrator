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
            static fn(array $e): string => $e['event'] ?? '',
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

    // --- Route tests for new endpoints ---

    public function testRouterSourceContainsAnthropicResponsesRoute(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/responses',
            self::$routerSource,
            'Router should define the Anthropic /anthropic/v1/responses route'
        );
    }

    public function testRouterSourceContainsAnthropicEmbeddingsRoute(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/embeddings',
            self::$routerSource,
            'Router should define the Anthropic /anthropic/v1/embeddings route'
        );
    }

    // --- Admin HTML reference tests ---

    public function testAdminHtmlContainsAnthropicResponsesReference(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/responses',
            self::$adminSource,
            'Admin HTML should reference the /anthropic/v1/responses endpoint'
        );
    }

    public function testAdminHtmlContainsAnthropicEmbeddingsReference(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/embeddings',
            self::$adminSource,
            'Admin HTML should reference the /anthropic/v1/embeddings endpoint'
        );
    }

    // --- API docs tests ---

    public function testApiDocsContainAnthropicResponsesDocumentation(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/responses',
            self::$apiDocSource,
            'API docs should document the /anthropic/v1/responses endpoint'
        );
    }

    public function testApiDocsContainAnthropicEmbeddingsDocumentation(): void
    {
        $this->assertStringContainsString(
            '/anthropic/v1/embeddings',
            self::$apiDocSource,
            'API docs should document the /anthropic/v1/embeddings endpoint'
        );
    }

    // --- AnthropicCompat normalization tests ---

    public function testAnthropicCompatNormalizesMessages(): void
    {
        $messages = \App\Http\AnthropicCompat::normalizeChatMessages([
            ['role' => 'user', 'content' => 'Hello Claude'],
        ]);

        $this->assertNotNull($messages);
        $this->assertCount(1, $messages);
        $this->assertSame('user', $messages[0]['role']);
        $this->assertSame('Hello Claude', $messages[0]['content']);
    }

    public function testAnthropicCompatExtractsSystemMessages(): void
    {
        $messages = [
            ['role' => 'system', 'content' => 'You are helpful.'],
            ['role' => 'user', 'content' => 'Hi'],
        ];

        $result = \App\Http\AnthropicCompat::extractSystemMessages($messages);

        $this->assertSame('You are helpful.', $result['system']);
        $this->assertCount(1, $result['messages']);
        $this->assertSame('user', $result['messages'][0]['role']);
    }

    public function testAnthropicCompatHandlesImageContent(): void
    {
        $messages = \App\Http\AnthropicCompat::normalizeChatMessages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image', 'source' => ['type' => 'url', 'url' => 'https://example.test/image.png']],
                ],
            ],
        ]);

        $this->assertNotNull($messages);
        $this->assertIsArray($messages[0]['content']);
        $this->assertCount(2, $messages[0]['content']);
    }

    // --- responseFromMessage test ---

    public function testAnthropicCompatResponseFromMessage(): void
    {
        if (!method_exists(\App\Http\AnthropicCompat::class, 'responseFromMessage')) {
            $this->markTestSkipped('responseFromMessage not yet implemented');
        }

        $response = \App\Http\AnthropicCompat::responseFromMessage([
            'id' => 'msg_abc123',
            'type' => 'message',
            'role' => 'assistant',
            'model' => 'claude-sonnet-4-6',
            'content' => [['type' => 'text', 'text' => 'pong']],
            'usage' => ['input_tokens' => 10, 'output_tokens' => 3],
        ]);

        $this->assertSame('response', $response['object']);
        $this->assertStringStartsWith('resp_', $response['id']);
        $this->assertSame('completed', $response['status']);
        $this->assertSame('pong', $response['output'][0]['content'][0]['text']);
        $this->assertSame(10, $response['usage']['input_tokens']);
        $this->assertSame(3, $response['usage']['output_tokens']);
    }
}
