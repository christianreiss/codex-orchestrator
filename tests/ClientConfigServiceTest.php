<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\LogRepository;
use App\Services\ClientConfigService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryClientConfigRepository extends ClientConfigRepository
{
    public ?array $row = null;

    public function __construct()
    {
    }

    public function latest(): ?array
    {
        return $this->row;
    }

    public function upsert(string $body, ?array $settings = null, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $computedSha = $sha256 ?? hash('sha256', $body);
        $createdAt = $this->row['created_at'] ?? $now;
        $this->row = [
            'id' => 1,
            'sha256' => $computedSha,
            'body' => $body,
            'settings' => $settings,
            'source_host_id' => $sourceHostId,
            'created_at' => $createdAt,
            'updated_at' => $now,
        ];

        return $this->row;
    }
}

final class NullLogRepositoryConfig extends LogRepository
{
    public array $records = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->records[] = [
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details,
        ];
    }
}

final class ClientConfigServiceTest extends TestCase
{
    private InMemoryClientConfigRepository $repository;
    private NullLogRepositoryConfig $logs;
    private ClientConfigService $service;

    protected function setUp(): void
    {
        $this->repository = new InMemoryClientConfigRepository();
        $this->logs = new NullLogRepositoryConfig();
        $this->service = new ClientConfigService($this->repository, $this->logs);
        ClientConfigService::resetCache();
    }

    public function testRenderBuildsTomlWithNoticeAndDefaults(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5-codex',
            'approval_policy' => 'on-request',
            'sandbox_mode' => 'workspace-write',
            'notice' => [
                'hide_gpt5_1_migration_prompt' => true,
            ],
            'features' => [
                'web_search_request' => true,
            ],
        ]);

        $this->assertNotEmpty($rendered['content']);
        $this->assertStringContainsString('model = "gpt-5-codex"', $rendered['content']);
        $this->assertStringContainsString('approval_policy = "on-request"', $rendered['content']);
        $this->assertStringContainsString('[notice]', $rendered['content']);
        $this->assertStringContainsString('hide_gpt5_1_migration_prompt = true', $rendered['content']);
        $this->assertEquals(64, strlen($rendered['sha256']));
    }

    public function testReasoningSummaryNoneIsStripped(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5-codex',
            'model_reasoning_summary' => 'none',
        ]);

        $this->assertStringNotContainsString('model_reasoning_summary', $rendered['content']);
    }

    public function testReasoningSummaryAutoPassesThrough(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5-codex',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "auto"', $rendered['content']);
    }

    public function testReasoningSummaryForcedDetailedForCodexMax(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.1-codex-max',
            'model_reasoning_summary' => 'concise',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "detailed"', $rendered['content']);
    }

    public function testStorePersistsAndDetectsUnchanged(): void
    {
        $first = $this->service->store(['settings' => ['model' => 'gpt-5-codex']]);
        $this->assertSame('created', $first['status']);
        $this->assertArrayHasKey('sha256', $first);
        $this->assertNotEmpty($this->repository->latest());

        $second = $this->service->store(['settings' => ['model' => 'gpt-5-codex']]);
        $this->assertSame('unchanged', $second['status']);
        $this->assertCount(2, $this->logs->records); // store + store
    }

    public function testRetrieveHonorsSha(): void
    {
        $stored = $this->service->store(['settings' => ['model' => 'gpt-5-codex']]);
        $sha = $stored['sha256'];

        $unchanged = $this->service->retrieve($sha, ['id' => 5]);
        $this->assertSame('unchanged', $unchanged['status']);
        $this->assertArrayNotHasKey('content', $unchanged);
        $this->assertArrayHasKey('base_sha256', $unchanged);

        $updated = $this->service->retrieve('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ['id' => 5]);
        $this->assertSame('updated', $updated['status']);
        $this->assertArrayHasKey('content', $updated);
    }

    public function testBakedShaChangesWhenApiKeyChanges(): void
    {
        $stored = $this->service->store(['settings' => ['model' => 'gpt-5-codex']]);
        $baseSha = $stored['sha256'];

        $first = $this->service->retrieve(null, ['id' => 1], 'https://example.test', 'api-key-one');
        $second = $this->service->retrieve(null, ['id' => 1], 'https://example.test', 'api-key-two');

        $this->assertSame($baseSha, $first['base_sha256']);
        $this->assertSame($baseSha, $second['base_sha256']);
        $this->assertNotSame($first['sha256'], $second['sha256'], 'baked sha must change when API key changes');
    }

    public function testStoreDetectsSettingsOnlyChange(): void
    {
        $first = $this->service->store(['settings' => ['model' => 'gpt-5-codex']]);
        $this->assertSame('created', $first['status']);

        $second = $this->service->store([
            'settings' => [
                'model' => 'gpt-5-codex',
                'orchestrator_mcp_enabled' => false,
            ],
        ]);

        $this->assertSame('updated', $second['status'], 'settings-only changes must be detected');
        $latest = $this->repository->latest();
        $this->assertNotNull($latest);
        $this->assertArrayHasKey('settings', $latest);
        $this->assertFalse($latest['settings']['orchestrator_mcp_enabled']);
    }

    public function testRenderForHostInjectsManagedMcpAndFiltersReserved(): void
    {
        $rendered = $this->service->renderForHost(
            [
                'mcp_servers' => [
                    ['name' => 'codex-memory', 'command' => 'noop'],
                    ['name' => 'user-custom', 'command' => '/bin/echo'],
                ],
            ],
            ['id' => 9],
            'https://coord.example',
            'abc123'
        );

        $content = $rendered['content'];
        $this->assertStringContainsString('[mcp_servers.cdx]', $content);
        $this->assertStringContainsString('url = "https://coord.example/mcp"', $content);
        $this->assertStringContainsString('Authorization = "Bearer abc123"', $content);
        $this->assertStringContainsString('[mcp_servers.user-custom]', $content);
        $this->assertStringNotContainsString('mcp_servers.codex-memory', $content);
    }
}
