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

    public function testModelsExposeSharedSupportedModelList(): void
    {
        $authService = $this->createMock(AuthService::class);
        $modelService = new OpenAiModelService($this->makeConfigRepo(), $this->makeVersionRepo());
        $adapter = new RunnerBackendAdapter('http://runner.test/exec', '', $authService, $modelService);

        $result = $adapter->models();
        $ids = array_map(static fn (array $row): string => (string) ($row['id'] ?? ''), $result['data']);

        $this->assertSame($modelService->supportedModels(), $ids);
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
