<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectDraftService;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryAuthPayloadRepositoryForProjectDraft extends AuthPayloadRepository
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

final class NullLogRepositoryProjectDraft extends LogRepository
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

final class StubRunnerVerifierForProjectDraft extends RunnerVerifier
{
    public array $calls = [];
    public array $result = [
        'status' => 'ok',
        'assistant_message' => 'Filled the weak metadata from the current project context.',
        'title' => 'SIP Proxy',
        'name' => 'sipproxy',
        'description' => 'Tracks the shared rollout and operating context for the SIP proxy stack.',
        'roster_markdown' => "- Service: SIP proxy\n- Keep handoff notes here.\n",
        'latency_ms' => 12,
        'reachable' => true,
        'codex_version' => 'test',
    ];

    public function __construct()
    {
    }

    public function assistProjectDraft(string $slug, array $project, array $authPayload, ?float $timeoutSeconds = null): array
    {
        $this->calls[] = compact('slug', 'project', 'authPayload', 'timeoutSeconds');

        return $this->result;
    }
}

final class ProjectDraftServiceTest extends TestCase
{
    private InMemoryAuthPayloadRepositoryForProjectDraft $payloads;
    private NullLogRepositoryProjectDraft $logs;
    private StubRunnerVerifierForProjectDraft $runner;
    private ProjectCoordinationService $projects;
    private ProjectDraftService $service;

    protected function setUp(): void
    {
        $this->payloads = new InMemoryAuthPayloadRepositoryForProjectDraft();
        $this->logs = new NullLogRepositoryProjectDraft();
        $this->runner = new StubRunnerVerifierForProjectDraft();
        $this->projects = $this->createMock(ProjectCoordinationService::class);
        $this->projects->method('projectDetail')->willReturn($this->sampleDetail());
        $this->service = new ProjectDraftService(
            $this->payloads,
            $this->logs,
            $this->projects,
            $this->runner
        );
    }

    public function testAssistUsesDecodedCanonicalBodyAndReturnsChangedFields(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-31T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];

        $result = $this->service->assist('sipproxy', ['id' => 5]);

        self::assertSame('sipproxy', $result['project']);
        self::assertSame('SIP Proxy', $result['about']['title'] ?? null);
        self::assertSame('sipproxy', $result['about']['name'] ?? null);
        self::assertSame(
            'Tracks the shared rollout and operating context for the SIP proxy stack.',
            $result['about']['description'] ?? null
        );
        self::assertSame(['title', 'name', 'description', 'roster_markdown'], $result['changed_fields']);
        self::assertSame('project.assist', $this->logs->records[0]['action']);
        self::assertSame('generated', $this->logs->records[0]['details']['status'] ?? null);
        self::assertSame('sipproxy', $this->runner->calls[0]['slug']);
        self::assertSame('sk-test-abcdefghijklmnopqrstuvwxyz123456', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['token'] ?? null);
        self::assertArrayHasKey('notes', $this->runner->calls[0]['project']);
        self::assertArrayHasKey('files', $this->runner->calls[0]['project']);
    }

    public function testAssistSkipsUnchangedSuggestions(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-31T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $this->runner->result = [
            'status' => 'ok',
            'assistant_message' => 'The current metadata already looks strong.',
            'title' => '',
            'name' => '',
            'description' => 'Existing description',
            'roster_markdown' => '',
            'latency_ms' => 9,
            'reachable' => true,
            'codex_version' => 'test',
        ];

        $result = $this->service->assist('sipproxy');

        self::assertSame([], $result['changed_fields']);
        self::assertSame([], $result['about']);
        self::assertSame('', $result['roster_markdown']);
    }

    public function testAssistThrowsWhenCanonicalAuthMissing(): void
    {
        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Canonical auth missing');

        $this->service->assist('sipproxy', ['id' => 8]);
    }

    public function testAssistThrowsWhenRunnerFails(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-31T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $this->runner->result = [
            'status' => 'fail',
            'reason' => 'runner timeout',
            'reachable' => false,
        ];

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Project assist failed: runner timeout');

        $this->service->assist('sipproxy');
    }

    public function testAssistRejectsMalformedRunnerPayload(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-31T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $this->runner->result = [
            'status' => 'ok',
            'assistant_message' => '',
            'title' => 'SIP Proxy',
        ];

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Project assist failed: invalid runner assist payload');

        $this->service->assist('sipproxy');
    }

    public function testAssistPrefersSharedCanonicalRunnerValidationSnapshot(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-31T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-stale-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];
        $runnerValidation = $this->createMock(RunnerValidationService::class);
        $runnerValidation->expects(self::once())
            ->method('canonicalAuthSnapshot')
            ->willReturn([
                'last_refresh' => '2026-03-31T11:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-canonical-abcdefghijklmnopqrstuvwxyz1234'],
                ],
            ]);

        $service = new ProjectDraftService(
            $this->payloads,
            $this->logs,
            $this->projects,
            $this->runner,
            $runnerValidation
        );
        $service->assist('sipproxy');

        self::assertSame(
            'sk-canonical-abcdefghijklmnopqrstuvwxyz1234',
            $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['token'] ?? null
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function sampleDetail(): array
    {
        return [
            'project' => [
                'slug' => 'sipproxy',
                'about' => [
                    'description' => 'Existing description',
                ],
                'roster_markdown' => '',
                'counts' => [
                    'notes' => 1,
                    'open_todos' => 1,
                    'done_todos' => 0,
                    'files' => 1,
                    'feedback' => 1,
                ],
            ],
            'notes' => [
                [
                    'id' => 1,
                    'header' => 'Discovery',
                    'body' => 'Proxying SIP traffic between edges and core.',
                    'updated_at' => '2026-03-31T10:10:00Z',
                ],
            ],
            'todos' => [
                [
                    'id' => 2,
                    'title' => 'Capture current topology',
                    'detail' => 'List trunks and failover behavior.',
                    'done' => false,
                    'updated_at' => '2026-03-31T10:11:00Z',
                ],
            ],
            'files' => [
                [
                    'id' => 3,
                    'stored_name' => 'notes/topology.md',
                    'description' => 'Current topology notes.',
                    'mime_type' => 'text/markdown',
                    'size_bytes' => 64,
                    'content' => "# Topology\n- edge-a\n- edge-b\n",
                ],
            ],
            'feedback' => [
                [
                    'id' => 4,
                    'type' => 'feature',
                    'title' => 'Need better health checks',
                    'body' => 'Add active failover visibility.',
                    'status' => 'open',
                    'updated_at' => '2026-03-31T10:12:00Z',
                ],
            ],
            'recent_changes' => [
                [
                    'seq' => 1,
                    'event_type' => 'project',
                    'action' => 'create',
                    'payload' => ['slug' => 'sipproxy'],
                    'created_at' => '2026-03-31T10:00:00Z',
                ],
            ],
        ];
    }
}
