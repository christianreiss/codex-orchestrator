<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\LogRepository;
use App\Services\RunnerVerifier;
use App\Services\SkillDraftService;
use App\Services\SkillManifestService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryAuthPayloadRepositoryForSkillDraft extends AuthPayloadRepository
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

final class NullLogRepositorySkillDraft extends LogRepository
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

final class StubRunnerVerifierForSkillDraft extends RunnerVerifier
{
    public array $calls = [];
    public array $result = [
        'status' => 'ok',
        'slug' => 'incident-handoff',
        'display_name' => 'Incident handoff',
        'description' => 'Guides a safe operator handoff.',
        'tags' => ['incident', 'handoff'],
        'what' => 'Summarize the situation, current state, and next steps.',
        'when' => 'Use when an issue needs a clean shift change or escalation.',
        'steps' => "1. Gather context.\n2. Capture risks.\n3. Confirm ownership.",
        'latency_ms' => 9,
        'reachable' => true,
        'codex_version' => 'test',
    ];

    public function __construct()
    {
    }

    public function generateSkillDraft(string $prompt, array $authPayload, ?string $slugHint = null, ?float $timeoutSeconds = null): array
    {
        $this->calls[] = compact('prompt', 'authPayload', 'slugHint', 'timeoutSeconds');

        return $this->result;
    }
}

final class SkillDraftServiceTest extends TestCase
{
    private InMemoryAuthPayloadRepositoryForSkillDraft $payloads;
    private NullLogRepositorySkillDraft $logs;
    private StubRunnerVerifierForSkillDraft $runner;
    private SkillDraftService $service;

    protected function setUp(): void
    {
        $this->payloads = new InMemoryAuthPayloadRepositoryForSkillDraft();
        $this->logs = new NullLogRepositorySkillDraft();
        $this->runner = new StubRunnerVerifierForSkillDraft();
        $this->service = new SkillDraftService(
            $this->payloads,
            $this->logs,
            new SkillManifestService(),
            $this->runner
        );
    }

    public function testGenerateUsesDecodedCanonicalBodyAndBuildsManifest(): void
    {
        $this->payloads->latestPayload = [
            'body' => json_encode([
                'last_refresh' => '2026-03-28T10:00:00Z',
                'auths' => [
                    'api.openai.com' => ['token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456'],
                ],
            ], JSON_THROW_ON_ERROR),
        ];

        $result = $this->service->generate([
            'prompt' => 'Make me a skill for incident handoffs.',
            'slug_hint' => 'incident-handoff',
        ], ['id' => 5]);

        self::assertSame('incident-handoff', $result['slug']);
        self::assertStringContainsString('name: "Incident handoff"', $result['manifest']);
        self::assertStringContainsString('## Step-by-Step Instructions', $result['manifest']);
        self::assertSame('incident-handoff', $this->runner->calls[0]['slugHint']);
        self::assertSame('skill.generate', $this->logs->records[0]['action']);
        self::assertSame('generated', $this->logs->records[0]['details']['status'] ?? null);
    }

    public function testGenerateFallsBackToEntriesWhenBodyMissing(): void
    {
        $this->payloads->latestPayload = [
            'last_refresh' => '2026-03-28T10:00:00Z',
            'entries' => [
                [
                    'target' => 'api.openai.com',
                    'token' => 'sk-test-abcdefghijklmnopqrstuvwxyz123456',
                    'token_type' => 'bearer',
                    'organization' => 'org_demo',
                ],
            ],
        ];

        $this->service->generate(['prompt' => 'Draft a deployment skill.']);

        self::assertSame('org_demo', $this->runner->calls[0]['authPayload']['auths']['api.openai.com']['organization'] ?? null);
    }

    public function testGenerateRejectsEmptyPrompt(): void
    {
        $this->expectException(ValidationException::class);

        $this->service->generate(['prompt' => '   ']);
    }

    public function testGenerateThrowsWhenCanonicalAuthMissing(): void
    {
        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Canonical auth missing');

        $this->service->generate(['prompt' => 'Draft a skill.'], ['id' => 9]);
    }

    public function testGenerateThrowsWhenRunnerFails(): void
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
            'reason' => 'runner timeout',
            'reachable' => false,
        ];

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Skill generation failed: runner timeout');

        $this->service->generate(['prompt' => 'Draft a skill.']);
    }

    public function testGenerateRejectsMalformedRunnerDraft(): void
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
            'status' => 'ok',
            'slug' => 'bad draft',
            'display_name' => '',
        ];

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Skill generation failed: invalid runner draft payload');

        $this->service->generate(['prompt' => 'Draft a skill.']);
    }
}
