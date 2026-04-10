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
        $authService = $this->createMock(AuthService::class);
        $authService->method('canonicalAuthSnapshot')->willReturn([
            'tokens' => ['access_token' => 'tok_test_12345678901234567890'],
        ]);

        $adapter = new class(
            'http://runner.test/exec',
            '',
            $authService,
            new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo()),
            12.5
        ) extends RunnerBackendAdapter {
            public array $seenPayloads = [];

            protected function attemptRequest(string $body): array
            {
                $decoded = json_decode($body, true);
                $this->seenPayloads[] = is_array($decoded) ? $decoded : [];

                return [
                    'status' => 'ok',
                    'output' => 'pong',
                ];
            }
        };

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
        $authService = $this->createMock(AuthService::class);
        $authService->method('canonicalAuthSnapshot')->willReturn([
            'tokens' => ['access_token' => 'tok_test_12345678901234567890'],
        ]);

        $adapter = new class(
            'http://runner.test/exec',
            '',
            $authService,
            new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo())
        ) extends RunnerBackendAdapter {
            public array $seenPayloads = [];

            protected function attemptRequest(string $body): array
            {
                $decoded = json_decode($body, true);
                $this->seenPayloads[] = is_array($decoded) ? $decoded : [];

                return [
                    'status' => 'ok',
                    'output' => 'image result',
                ];
            }
        };

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

    /**
     * @return RunnerBackendAdapter&object{seenPayloads: array<int, array<string, mixed>>}
     */
    private function makeTestAdapter(string $output): RunnerBackendAdapter
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
            30.0,
            $output
        ) extends RunnerBackendAdapter {
            public array $seenPayloads = [];

            public function __construct(
                string $runnerExecUrl,
                string $sharedSecret,
                AuthService $authService,
                OpenAiModelService $modelService,
                float $timeout,
                private readonly string $fixedOutput,
            ) {
                parent::__construct($runnerExecUrl, $sharedSecret, $authService, $modelService, $timeout);
            }

            protected function attemptRequest(string $body): array
            {
                $decoded = json_decode($body, true);
                $this->seenPayloads[] = is_array($decoded) ? $decoded : [];

                return [
                    'status' => 'ok',
                    'output' => $this->fixedOutput,
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
