<?php

declare(strict_types=1);

use App\Adapters\ClaudeBackendAdapter;
use App\Contracts\BackendAdapter;
use PHPUnit\Framework\TestCase;

final class ClaudeBackendAdapterTest extends TestCase
{
    public function testImplementsBackendAdapterInterface(): void
    {
        $reflection = new ReflectionClass(ClaudeBackendAdapter::class);
        $this->assertTrue($reflection->implementsInterface(BackendAdapter::class));
    }

    public function testModelsReturnsListWithAnthropicOwnedBy(): void
    {
        $adapter = $this->createAdapter();
        $result = $adapter->models();

        $this->assertSame('list', $result['object']);
        $this->assertIsArray($result['data']);
        $this->assertNotEmpty($result['data']);

        foreach ($result['data'] as $model) {
            $this->assertSame('model', $model['object']);
            $this->assertSame('anthropic', $model['owned_by']);
            $this->assertArrayHasKey('id', $model);
            $this->assertArrayHasKey('created', $model);
        }
    }

    public function testModelsContainsExpectedClaudeModels(): void
    {
        $adapter = $this->createAdapter();
        $result = $adapter->models();

        $modelIds = array_map(
            static fn(array $m): string => (string) ($m['id'] ?? ''),
            $result['data']
        );

        $hasClaudeModel = false;
        foreach ($modelIds as $id) {
            if (str_contains($id, 'claude')) {
                $hasClaudeModel = true;
                break;
            }
        }
        $this->assertTrue($hasClaudeModel, 'Expected at least one Claude model in the list');
    }

    public function testEmbeddingsReturnsNotImplementedError(): void
    {
        $adapter = $this->createAdapter();
        $result = $adapter->embeddings('test input', 'claude-sonnet-4-6');

        $this->assertArrayHasKey('error', $result);
        $this->assertSame('not_implemented', $result['error']['type'] ?? $result['error']['code'] ?? null);
    }

    public function testMessagesReturnsCorrectAnthropicResponseFormat(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Hello from Claude!',
        ]);

        if (!method_exists($adapter, 'messages')) {
            $this->markTestSkipped('messages() method not yet implemented on ClaudeBackendAdapter');
        }

        $result = $adapter->messages([
            ['role' => 'user', 'content' => 'Hello'],
        ], 'claude-sonnet-4-6');

        $this->assertStringStartsWith('msg_', $result['id']);
        $this->assertSame('message', $result['type']);
        $this->assertSame('assistant', $result['role']);
        $this->assertSame('claude-sonnet-4-6', $result['model']);
        $this->assertSame('end_turn', $result['stop_reason']);
        $this->assertIsArray($result['content']);
        $this->assertSame('text', $result['content'][0]['type']);
        $this->assertSame('Hello from Claude!', $result['content'][0]['text']);
        $this->assertIsArray($result['usage']);
    }

    public function testChatCompletionsReturnsCorrectOpenAiFormat(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Test reply',
        ]);

        $result = $adapter->chatCompletions([
            ['role' => 'user', 'content' => 'Hello'],
        ], 'claude-sonnet-4-6');

        $this->assertSame('chat.completion', $result['object']);
        $this->assertStringStartsWith('chatcmpl-', $result['id']);
        $this->assertSame('claude-sonnet-4-6', $result['model']);
        $this->assertIsArray($result['choices']);
        $this->assertCount(1, $result['choices']);
        $this->assertSame('assistant', $result['choices'][0]['message']['role']);
        $this->assertSame('Test reply', $result['choices'][0]['message']['content']);
        $this->assertSame('stop', $result['choices'][0]['finish_reason']);
        $this->assertIsArray($result['usage']);
    }

    public function testCompletionsReturnsCorrectOpenAiTextCompletionFormat(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Completed text',
        ]);

        $result = $adapter->completions('Complete this:', 'claude-sonnet-4-6');

        $this->assertSame('text_completion', $result['object']);
        $this->assertStringStartsWith('cmpl-', $result['id']);
        $this->assertSame('claude-sonnet-4-6', $result['model']);
        $this->assertIsArray($result['choices']);
        $this->assertSame('Completed text', $result['choices'][0]['text']);
        $this->assertSame('stop', $result['choices'][0]['finish_reason']);
    }

    public function testChatCompletionsWithEmptyMessagesReturnsEmptyContent(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => '',
        ]);

        $result = $adapter->chatCompletions([], 'claude-sonnet-4-6');

        $this->assertSame('chat.completion', $result['object']);
        $content = $result['choices'][0]['message']['content'] ?? '';
        $this->assertSame('', $content);
    }

    // --- New parameter passthrough and content type tests ---

    public function testMessagesAcceptsOptionalParamsArray(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Hello!',
        ]);

        if (!method_exists($adapter, 'messages')) {
            $this->markTestSkipped('messages() not available');
        }

        $ref = new ReflectionMethod($adapter, 'messages');
        if ($ref->getNumberOfParameters() < 3) {
            $this->markTestSkipped('messages() does not yet accept a $params argument');
        }

        $result = $adapter->messages(
            [['role' => 'user', 'content' => 'Test']],
            'claude-sonnet-4-6',
            ['max_tokens' => 100, 'temperature' => 0.7]
        );

        $this->assertSame('message', $result['type']);
        $this->assertSame('Hello!', $result['content'][0]['text']);
    }

    public function testMessagesWorksWithoutParamsForBackwardCompatibility(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Hello!',
        ]);

        if (!method_exists($adapter, 'messages')) {
            $this->markTestSkipped('messages() not available');
        }

        $result = $adapter->messages(
            [['role' => 'user', 'content' => 'Test']],
            'claude-sonnet-4-6'
        );

        $this->assertSame('message', $result['type']);
    }

    public function testChatCompletionsAcceptsOptionalParamsArray(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'Hi there',
        ]);

        $ref = new ReflectionMethod($adapter, 'chatCompletions');
        if ($ref->getNumberOfParameters() < 3) {
            $this->markTestSkipped('chatCompletions() does not yet accept a $params argument');
        }

        $result = $adapter->chatCompletions(
            [['role' => 'user', 'content' => 'Hello']],
            'claude-sonnet-4-6',
            ['temperature' => 0.5]
        );

        $this->assertSame('chat.completion', $result['object']);
        $this->assertSame('Hi there', $result['choices'][0]['message']['content']);
    }

    public function testMessagesHandlesMultipartContent(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'I see an image',
        ]);

        if (!method_exists($adapter, 'messages')) {
            $this->markTestSkipped('messages() not available');
        }

        $result = $adapter->messages([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => 'image/png', 'data' => 'iVBOR']],
                ],
            ],
        ], 'claude-sonnet-4-6');

        $this->assertSame('message', $result['type']);
        $this->assertSame('I see an image', $result['content'][0]['text']);
    }

    public function testMessagesUsageIncludesCacheTokenFields(): void
    {
        $adapter = $this->createAdapterWithCannedResponse([
            'status' => 'ok',
            'output' => 'response',
            'input_tokens' => 100,
            'output_tokens' => 50,
            'cache_creation_input_tokens' => 20,
            'cache_read_input_tokens' => 30,
        ]);

        if (!method_exists($adapter, 'messages')) {
            $this->markTestSkipped('messages() not available');
        }

        $result = $adapter->messages(
            [['role' => 'user', 'content' => 'Test']],
            'claude-sonnet-4-6'
        );

        $usage = $result['usage'];
        $this->assertSame(100, $usage['input_tokens']);
        $this->assertSame(50, $usage['output_tokens']);
        $this->assertSame(20, $usage['cache_creation_input_tokens']);
        $this->assertSame(30, $usage['cache_read_input_tokens']);
    }

    // --- Helper methods ---

    private function createAdapter(): ClaudeBackendAdapter
    {
        $reflection = new ReflectionClass(ClaudeBackendAdapter::class);
        $args = $this->resolveConstructorArgs($reflection);

        return $reflection->newInstanceArgs($args);
    }

    private function createAdapterWithCannedResponse(array $cannedResponse): ClaudeBackendAdapter
    {
        $reflection = new ReflectionClass(ClaudeBackendAdapter::class);

        $method = $reflection->hasMethod('attemptRequest')
            ? $reflection->getMethod('attemptRequest')
            : null;

        if ($method === null || $method->isPrivate()) {
            return $this->createAdapter();
        }

        $parentArgs = $this->resolveConstructorArgs($reflection, stubAuth: true);

        return new class(...[...$parentArgs, $cannedResponse]) extends ClaudeBackendAdapter {
            private array $testCannedResponse;

            public function __construct(mixed ...$args)
            {
                $this->testCannedResponse = array_pop($args);
                parent::__construct(...$args);
            }

            protected function attemptRequest(string $body): array
            {
                return $this->testCannedResponse;
            }
        };
    }

    /**
     * @return list<mixed>
     */
    private function resolveConstructorArgs(ReflectionClass $reflection, bool $stubAuth = false): array
    {
        $constructor = $reflection->getConstructor();
        if ($constructor === null) {
            return [];
        }

        $args = [];
        foreach ($constructor->getParameters() as $param) {
            $type = $param->getType();
            $typeName = $type instanceof ReflectionNamedType ? $type->getName() : '';

            if ($param->isDefaultValueAvailable()) {
                $args[] = $param->getDefaultValue();
            } elseif ($typeName === 'string') {
                $args[] = $param->getName() === 'sharedSecret' ? '' : 'http://runner.test/exec';
            } elseif ($typeName === 'float') {
                $args[] = 30.0;
            } elseif ($typeName === 'array') {
                $args[] = [];
            } elseif ($type !== null && !$type->isBuiltin()) {
                $mock = $this->createMock($typeName);
                if ($stubAuth && ($typeName === 'App\Services\AuthService' || str_ends_with($typeName, 'AuthService'))) {
                    $mock->method('canonicalAuthSnapshot')->willReturn([
                        'tokens' => ['access_token' => 'test_token'],
                    ]);
                }
                if ($typeName === 'App\Services\ClaudeModelService' || str_ends_with($typeName, 'ClaudeModelService')) {
                    $mock->method('supportedModels')->willReturn(\App\Services\ClaudeModelService::SUPPORTED_MODELS);
                }
                $args[] = $mock;
            } else {
                $args[] = null;
            }
        }

        return $args;
    }
}
