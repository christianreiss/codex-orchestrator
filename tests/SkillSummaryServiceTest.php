<?php

declare(strict_types=1);

use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;
use App\Services\RunnerVerifier;
use App\Services\SkillSummaryService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryAuthPayloadRepositoryForSkillSummary extends AuthPayloadRepository
{
    public ?array $latestPayload = null;

    public function __construct()
    {
    }

    public function latest(): ?array
    {
        return $this->latestPayload;
    }
}

final class NullLogRepositorySkillSummary extends LogRepository
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

final class StubRunnerVerifierForSkillSummary extends RunnerVerifier
{
    public array $calls = [];
    public array $result = [
        'status' => 'ok',
        'summary' => 'Generates deployment plans.',
        'latency_ms' => 4,
        'reachable' => true,
    ];

    public function __construct()
    {
    }

    public function summarizeSkill(string $slug, string $manifest, array $authPayload, ?float $timeoutSeconds = null): array
    {
        $this->calls[] = compact('slug', 'manifest', 'authPayload', 'timeoutSeconds');

        return $this->result;
    }
}

final class SkillSummaryServiceTest extends TestCase
{
    private InMemoryAuthPayloadRepositoryForSkillSummary $payloads;
    private NullLogRepositorySkillSummary $logs;
    private StubRunnerVerifierForSkillSummary $runner;
    private SkillSummaryService $service;

    protected function setUp(): void
    {
        $this->payloads = new InMemoryAuthPayloadRepositoryForSkillSummary();
        $this->logs = new NullLogRepositorySkillSummary();
        $this->runner = new StubRunnerVerifierForSkillSummary();
        $this->service = new SkillSummaryService($this->payloads, $this->logs, $this->runner);
    }

    public function testSummarizeUsesDecodedCanonicalBodyWhenAvailable(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-28T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];

        $summary = $this->service->summarize('deploy', "# Deploy\n");

        self::assertSame('Generates deployment plans.', $summary);
        self::assertCount(1, $this->runner->calls);
        self::assertSame(
            'sk-test-abcdefghijklmnopqrstuvwxyz123456',
            $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['token'] ?? null
        );
    }

    public function testSummarizeFallsBackToEntriesWhenBodyMissing(): void
    {
        $this->payloads->latestPayload = [
            'last_refresh' => '2026-03-28T10:00:00Z',
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

        $summary = $this->service->summarize('deploy', "# Deploy\n");

        self::assertSame('Generates deployment plans.', $summary);
        self::assertSame('org_demo', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['organization'] ?? null);
        self::assertSame('value', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['extra'] ?? null);
    }

    public function testSummarizeReturnsNullWhenCanonicalAuthMissing(): void
    {
        $summary = $this->service->summarize('deploy', "# Deploy\n", ['id' => 9]);

        self::assertNull($summary);
        self::assertSame('skill.summary', $this->logs->records[0]['action']);
        self::assertSame('skipped', $this->logs->records[0]['details']['status'] ?? null);
        self::assertCount(0, $this->runner->calls);
    }

    public function testSummarizeReturnsNullWhenRunnerFails(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-28T10:00:00Z',
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

        $summary = $this->service->summarize('deploy', "# Deploy\n");

        self::assertNull($summary);
        self::assertSame('failed', $this->logs->records[0]['details']['status'] ?? null);
    }
}
