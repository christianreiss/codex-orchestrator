<?php

declare(strict_types=1);

use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;
use App\Services\MemorySummaryService;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryAuthPayloadRepositoryForMemorySummary extends AuthPayloadRepository
{
    public ?array $latestPayload = null;

    public function __construct()
    {
    }

    public function latest(string $engine = 'codex'): ?array
    {
        return $this->latestPayload;
    }
}

final class NullLogRepositoryMemorySummary extends LogRepository
{
    public array $records = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->records[] = compact('hostId', 'action', 'details');
    }
}

final class StubRunnerVerifierForMemorySummary extends RunnerVerifier
{
    public array $calls = [];
    public array $result = [
        'status' => 'ok',
        'summary' => 'Captures deployment notes and host-specific caveats.',
        'latency_ms' => 5,
        'reachable' => true,
    ];

    public function __construct()
    {
    }

    public function summarizeMemory(string $memoryKey, string $content, array $authPayload, ?float $timeoutSeconds = null): array
    {
        $this->calls[] = compact('memoryKey', 'content', 'authPayload', 'timeoutSeconds');

        return $this->result;
    }
}

final class MemorySummaryServiceTest extends TestCase
{
    private InMemoryAuthPayloadRepositoryForMemorySummary $payloads;
    private NullLogRepositoryMemorySummary $logs;
    private StubRunnerVerifierForMemorySummary $runner;
    private MemorySummaryService $service;

    protected function setUp(): void
    {
        $this->payloads = new InMemoryAuthPayloadRepositoryForMemorySummary();
        $this->logs = new NullLogRepositoryMemorySummary();
        $this->runner = new StubRunnerVerifierForMemorySummary();
        $this->service = new MemorySummaryService($this->payloads, $this->logs, $this->runner);
    }

    public function testSummarizeUsesDecodedCanonicalBodyWhenAvailable(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-30T09:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];

        $summary = $this->service->summarize('deploy.notes', "Drain the queue first.\n");

        self::assertSame('Captures deployment notes and host-specific caveats.', $summary);
        self::assertCount(1, $this->runner->calls);
        self::assertSame(
            'sk-test-abcdefghijklmnopqrstuvwxyz123456',
            $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['token'] ?? null
        );
    }

    public function testSummarizeFallsBackToEntriesWhenBodyMissing(): void
    {
        $this->payloads->latestPayload = [
            'last_refresh' => '2026-03-30T09:00:00Z',
            'entries' => [
                [
                    'target' => 'api.openai.com',
                    'token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456',
                    'token_type' => 'bearer',
                    'organization' => 'org_demo',
                    'project' => 'proj_demo',
                    'api_base' => 'https://api.openai.com',
                    'meta' => ['extra' => 'value'],
                ],
            ],
        ];

        $summary = $this->service->summarize('deploy.notes', "Drain the queue first.\n");

        self::assertSame('Captures deployment notes and host-specific caveats.', $summary);
        self::assertSame('org_demo', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['organization'] ?? null);
        self::assertSame('value', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['extra'] ?? null);
    }

    public function testSummarizeReturnsNullWhenCanonicalAuthMissing(): void
    {
        $summary = $this->service->summarize('deploy.notes', "Drain the queue first.\n", ['id' => 9]);

        self::assertNull($summary);
        self::assertSame('memory.summary', $this->logs->records[0]['action']);
        self::assertSame('skipped', $this->logs->records[0]['details']['status'] ?? null);
        self::assertCount(0, $this->runner->calls);
    }

    public function testSummarizeReturnsNullWhenRunnerFails(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-30T09:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $this->runner->result = [
            'status' => 'fail',
            'reason' => 'summary failed',
            'reachable' => true,
        ];

        $summary = $this->service->summarize('deploy.notes', "Drain the queue first.\n");

        self::assertNull($summary);
        self::assertSame('failed', $this->logs->records[0]['details']['status'] ?? null);
    }

    public function testSummarizePrefersSharedCanonicalRunnerValidationSnapshot(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-30T09:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-stale-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $runnerValidation = $this->createMock(RunnerValidationService::class);
        $runnerValidation->expects(self::once())
            ->method('canonicalAuthSnapshot')
            ->willReturn([
                'last_refresh' => '2026-03-30T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-canonical-abcdefghijklmnopqrstuvwxyz1234'],
                ],
            ]);

        $service = new MemorySummaryService($this->payloads, $this->logs, $this->runner, $runnerValidation);
        $summary = $service->summarize('deploy.notes', "Drain the queue first.\n");

        self::assertSame('Captures deployment notes and host-specific caveats.', $summary);
        self::assertSame(
            'sk-canonical-abcdefghijklmnopqrstuvwxyz1234',
            $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['token'] ?? null
        );
    }
}
