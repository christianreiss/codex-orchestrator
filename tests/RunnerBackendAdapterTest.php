<?php

declare(strict_types=1);

use App\Adapters\RunnerBackendAdapter;
use App\Repositories\ClientConfigRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\OpenAiModelService;
use PHPUnit\Framework\TestCase;

final class RunnerBackendAdapterTest extends TestCase
{
    public function testChatCompletionsSendSelectedModelToRunnerExecPayload(): void
    {
        $adapter = $this->makeTestAdapter('pong', 12.5);

        $result = $adapter->chatCompletions([
            ['role' => 'user', 'content' => 'Hello'],
        ], 'gpt-5.4');

        $this->assertSame('gpt-5.4', $result['model']);
        $this->assertCount(1, $adapter->seenPayloads);
        $this->assertSame('gpt-5.4', $adapter->seenPayloads[0]['model']);
        $this->assertSame(12.5, $adapter->seenPayloads[0]['timeout_seconds']);
    }

    public function testChatCompletionsForwardImagePartsToRunnerExecPayload(): void
    {
        $adapter = $this->makeTestAdapter('image result');

        $adapter->chatCompletions([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'Describe this image.'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/cat.png', 'detail' => 'high']],
                ],
            ],
        ], 'gpt-5.4');

        $this->assertCount(1, $adapter->seenPayloads);
        $this->assertSame("user: Describe this image.\n[Image 1 attached]", $adapter->seenPayloads[0]['prompt']);
        $this->assertSame([
            ['url' => 'https://example.test/cat.png', 'detail' => 'high'],
        ], $adapter->seenPayloads[0]['images']);
    }

    public function testModelsExposeSharedSupportedModelList(): void
    {
        $authService = $this->createMock(AuthService::class);
        $modelService = new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo());
        $adapter = new RunnerBackendAdapter('http://runner.test/exec', '', $authService, $modelService);

        $result = $adapter->models();
        $ids = array_map(static fn (array $row): string => (string) ($row['id'] ?? ''), $result['data']);

        $this->assertSame($modelService->supportedModels(), $ids);
    }

    public function testImplementsBackendAdapter(): void
    {
        $authService = $this->createMock(AuthService::class);
        $modelService = new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo());
        $adapter = new RunnerBackendAdapter('http://runner.test/exec', '', $authService, $modelService);

        $this->assertInstanceOf(\App\Contracts\BackendAdapter::class, $adapter);
    }

    public function testChatCompletionsReturnsCorrectFormat(): void
    {
        $adapter = $this->makeTestAdapter('Backend reply');

        $result = $adapter->chatCompletions([
            ['role' => 'user', 'content' => 'Hello'],
        ], 'gpt-5.4');

        $this->assertStringStartsWith('chatcmpl-', $result['id']);
        $this->assertSame('chat.completion', $result['object']);
        $this->assertSame('gpt-5.4', $result['model']);
        $this->assertIsInt($result['created']);
        $this->assertCount(1, $result['choices']);
        $this->assertSame(0, $result['choices'][0]['index']);
        $this->assertSame('assistant', $result['choices'][0]['message']['role']);
        $this->assertSame('Backend reply', $result['choices'][0]['message']['content']);
        $this->assertSame('stop', $result['choices'][0]['finish_reason']);
        $this->assertArrayHasKey('usage', $result);
        $this->assertArrayHasKey('prompt_tokens', $result['usage']);
        $this->assertArrayHasKey('completion_tokens', $result['usage']);
        $this->assertArrayHasKey('total_tokens', $result['usage']);
    }

    public function testCompletionsReturnsCorrectFormat(): void
    {
        $adapter = $this->makeTestAdapter('Completion output');

        $result = $adapter->completions('Some prompt', 'gpt-5.4');

        $this->assertStringStartsWith('cmpl-', $result['id']);
        $this->assertSame('text_completion', $result['object']);
        $this->assertSame('gpt-5.4', $result['model']);
        $this->assertIsInt($result['created']);
        $this->assertCount(1, $result['choices']);
        $this->assertSame(0, $result['choices'][0]['index']);
        $this->assertSame('Completion output', $result['choices'][0]['text']);
        $this->assertNull($result['choices'][0]['logprobs']);
        $this->assertSame('stop', $result['choices'][0]['finish_reason']);
        $this->assertArrayHasKey('usage', $result);
    }

    public function testEmbeddingsReturnsError(): void
    {
        $authService = $this->createMock(AuthService::class);
        $modelService = new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo());
        $adapter = new RunnerBackendAdapter('http://runner.test/exec', '', $authService, $modelService);

        $result = $adapter->embeddings('test input', 'text-embedding-3-small');

        $this->assertArrayHasKey('error', $result);
        $this->assertSame('not_implemented', $result['error']['type']);
        $this->assertSame('not_implemented', $result['error']['code']);
        $this->assertStringContainsString('not supported', $result['error']['message']);
    }

    public function testModelsReturnsCorrectFormat(): void
    {
        $authService = $this->createMock(AuthService::class);
        $modelService = new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo());
        $adapter = new RunnerBackendAdapter('http://runner.test/exec', '', $authService, $modelService);

        $result = $adapter->models();

        $this->assertSame('list', $result['object']);
        $this->assertIsArray($result['data']);
        $this->assertNotEmpty($result['data']);

        foreach ($result['data'] as $model) {
            $this->assertArrayHasKey('id', $model);
            $this->assertSame('model', $model['object']);
            $this->assertArrayHasKey('created', $model);
            $this->assertSame('codex-orchestrator', $model['owned_by']);
        }
    }

    public function testEmptyPromptReturnsEmpty(): void
    {
        $adapter = $this->makeTestAdapter('should not appear');

        $result = $adapter->completions('', 'gpt-5.4');

        $this->assertSame('', $result['choices'][0]['text']);
    }

    public function testChatCompletionsWithImages(): void
    {
        $adapter = $this->makeTestAdapter('Image described');

        $adapter->chatCompletions([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/cat.png', 'detail' => 'auto']],
                ],
            ],
        ], 'gpt-5.4');

        $this->assertCount(1, $adapter->seenPayloads);
        $payload = $adapter->seenPayloads[0];
        $this->assertStringContainsString('What is this?', $payload['prompt']);
        $this->assertStringContainsString('[Image 1 attached]', $payload['prompt']);
        $this->assertCount(1, $payload['images']);
        $this->assertSame('https://example.test/cat.png', $payload['images'][0]['url']);
        $this->assertSame('auto', $payload['images'][0]['detail']);
    }

    public function testMultipartContentHandling(): void
    {
        $adapter = $this->makeTestAdapter('Multi response');

        $adapter->chatCompletions([
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'First text part'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/a.png']],
                    ['type' => 'text', 'text' => 'Second text part'],
                    ['type' => 'image_url', 'image_url' => ['url' => 'https://example.test/b.png', 'detail' => 'low']],
                ],
            ],
        ], 'gpt-5.4');

        $this->assertCount(1, $adapter->seenPayloads);
        $payload = $adapter->seenPayloads[0];
        $this->assertStringContainsString('First text part', $payload['prompt']);
        $this->assertStringContainsString('Second text part', $payload['prompt']);
        $this->assertStringContainsString('[Image 1 attached]', $payload['prompt']);
        $this->assertStringContainsString('[Image 2 attached]', $payload['prompt']);
        $this->assertCount(2, $payload['images']);
        $this->assertSame('https://example.test/a.png', $payload['images'][0]['url']);
        $this->assertSame('https://example.test/b.png', $payload['images'][1]['url']);
        $this->assertSame('low', $payload['images'][1]['detail']);
    }

    public function testMessagesReturnsCorrectAnthropicFormat(): void
    {
        $adapter = $this->makeTestAdapter('Hello from messages');
        $result = $adapter->messages([
            ['role' => 'user', 'content' => 'Hello'],
        ], 'gpt-5.4');

        $this->assertStringStartsWith('msg_', $result['id']);
        $this->assertSame('message', $result['type']);
        $this->assertSame('assistant', $result['role']);
        $this->assertSame('gpt-5.4', $result['model']);
        $this->assertSame('end_turn', $result['stop_reason']);
        $this->assertNull($result['stop_sequence']);
        $this->assertIsArray($result['content']);
        $this->assertCount(1, $result['content']);
        $this->assertSame('text', $result['content'][0]['type']);
        $this->assertSame('Hello from messages', $result['content'][0]['text']);
        $this->assertArrayHasKey('input_tokens', $result['usage']);
        $this->assertArrayHasKey('output_tokens', $result['usage']);
        $this->assertArrayHasKey('cache_creation_input_tokens', $result['usage']);
        $this->assertArrayHasKey('cache_read_input_tokens', $result['usage']);
    }

    public function testMessagesForwardsParamsToRunner(): void
    {
        $adapter = $this->makeTestAdapter('Param test');
        $adapter->messages(
            [['role' => 'user', 'content' => 'Test']],
            'gpt-5.4',
            ['max_tokens' => 100, 'temperature' => 0.5]
        );

        $this->assertCount(1, $adapter->seenPayloads);
        $this->assertSame(100, $adapter->seenPayloads[0]['max_tokens']);
        $this->assertSame(0.5, $adapter->seenPayloads[0]['temperature']);
    }

    private function makeTestAdapter(string $output, float $timeout = 30.0): RunnerBackendAdapter
    {
        $authService = $this->createMock(AuthService::class);
        $authService->method('canonicalAuthSnapshot')->willReturn([
            'tokens' => ['access_token' => 'tok_test_12345678901234567890'],
        ]);

        return new class(
            'http://runner.test/exec',
            '',
            $authService,
            new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo()),
            $timeout,
            $output
        ) extends RunnerBackendAdapter {
            /** @var list<array<string, mixed>> */
            public array $seenPayloads = [];

            public function __construct(
                string $runnerExecUrl,
                string $sharedSecret,
                AuthService $authService,
                OpenAiModelService $modelService,
                float $timeout,
                private readonly string $cannedOutput,
            ) {
                parent::__construct($runnerExecUrl, $sharedSecret, $authService, $modelService, $timeout);
            }

            protected function attemptRequest(string $body): array
            {
                $decoded = json_decode($body, true);
                $this->seenPayloads[] = is_array($decoded) ? $decoded : [];

                return [
                    'status' => 'ok',
                    'output' => $this->cannedOutput,
                ];
            }
        };
    }

    private function makeConfigRepo(): ClientConfigRepository
    {
        return new class() extends ClientConfigRepository {
            public function __construct()
            {
            }

            public function latest(): ?array
            {
                return null;
            }
        };
    }

    private function makeVersionRepo(): VersionRepository
    {
        return new class() extends VersionRepository {
            public function __construct()
            {
            }

            public function get(string $name): ?string
            {
                return null;
            }
        };
    }
}
