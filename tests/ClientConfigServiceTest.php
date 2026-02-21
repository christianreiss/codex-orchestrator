<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\LogRepository;
use App\Exceptions\ValidationException;
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
            'model' => 'gpt-5.3-codex-spark',
            'model_provider' => 'oss',
            'local_provider' => 'ollama',
            'approval_policy' => 'on-request',
            'sandbox_mode' => 'workspace-write',
            'security' => [
                'dangerously_bypass_approvals_and_sandbox' => true,
            ],
            'notice' => [
                'hide_gpt5_1_migration_prompt' => true,
                'model_migrations' => [
                    'gpt-5.2-codex' => 'gpt-5.3-codex',
                ],
            ],
            'features' => [
                'web_search' => 'live',
            ],
        ]);

        $this->assertNotEmpty($rendered['content']);
        $this->assertStringContainsString('model = "gpt-5.3-codex-spark"', $rendered['content']);
        $this->assertStringContainsString('model_provider = "oss"', $rendered['content']);
        $this->assertStringContainsString('local_provider = "ollama"', $rendered['content']);
        $this->assertStringContainsString('approval_policy = "on-request"', $rendered['content']);
        $this->assertStringContainsString('web_search = "live"', $rendered['content']);
        $this->assertStringContainsString('[notice]', $rendered['content']);
        $this->assertStringContainsString('[security]', $rendered['content']);
        $this->assertStringContainsString('dangerously_bypass_approvals_and_sandbox = true', $rendered['content']);
        $this->assertStringContainsString('hide_gpt5_1_migration_prompt = true', $rendered['content']);
        $this->assertStringContainsString('model_migrations = { "gpt-5.2-codex" = "gpt-5.3-codex" }', $rendered['content']);
        $this->assertEquals(64, strlen($rendered['sha256']));
    }

    public function testReasoningSummaryNoneIsStripped(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.2',
            'model_reasoning_summary' => 'none',
        ]);

        $this->assertStringNotContainsString('model_reasoning_summary', $rendered['content']);
    }

    public function testLegacyWebSearchRequestMapsToWebSearch(): void
    {
        $rendered = $this->service->render([
            'features' => [
                'web_search_request' => true,
            ],
        ]);

        $this->assertStringContainsString('web_search = "live"', $rendered['content']);
        $this->assertArrayHasKey('web_search', $rendered['settings']);
        $this->assertSame('live', $rendered['settings']['web_search']);
        $this->assertArrayNotHasKey('web_search_request', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('web_search', $rendered['settings']['features']);
    }

    public function testDeprecatedApprovalPolicyOnFailureMigratesToOnRequest(): void
    {
        $rendered = $this->service->render([
            'approval_policy' => 'on-failure',
        ]);

        $this->assertStringContainsString('approval_policy = "on-request"', $rendered['content']);
        $this->assertSame('on-request', $rendered['settings']['approval_policy']);
        $this->assertStringNotContainsString('approval_policy = "on-failure"', $rendered['content']);
    }

    public function testDeprecatedProfileApprovalPolicyOnFailureMigratesToOnRequest(): void
    {
        $rendered = $this->service->render([
            'profiles' => [
                [
                    'name' => 'legacy',
                    'approval_policy' => 'on-failure',
                ],
            ],
        ]);

        $this->assertStringContainsString('[profiles.legacy]', $rendered['content']);
        $this->assertStringContainsString('approval_policy = "on-request"', $rendered['content']);
        $this->assertSame('on-request', $rendered['settings']['profiles'][0]['approval_policy']);
        $this->assertStringNotContainsString('approval_policy = "on-failure"', $rendered['content']);
    }

    public function testSteerDefaultsToTrueAndCanDisable(): void
    {
        $renderedDefault = $this->service->render([]);
        $this->assertStringContainsString('[features]', $renderedDefault['content']);
        $this->assertStringContainsString('multi_agent = true', $renderedDefault['content']);
        $this->assertStringContainsString('steer = true', $renderedDefault['content']);

        $renderedDisabled = $this->service->render(['steer' => false]);
        $this->assertStringContainsString('[features]', $renderedDisabled['content']);
        $this->assertStringContainsString('steer = false', $renderedDisabled['content']);
    }

    public function testMultiAgentDefaultsToTrueAndCanDisable(): void
    {
        $renderedDefault = $this->service->render([]);
        $this->assertStringContainsString('[features]', $renderedDefault['content']);
        $this->assertStringContainsString('multi_agent = true', $renderedDefault['content']);
        $this->assertSame(true, $renderedDefault['settings']['features']['multi_agent']);

        $renderedDisabled = $this->service->render([
            'features' => [
                'multi_agent' => false,
            ],
        ]);
        $this->assertStringContainsString('[features]', $renderedDisabled['content']);
        $this->assertStringContainsString('multi_agent = false', $renderedDisabled['content']);
        $this->assertSame(false, $renderedDisabled['settings']['features']['multi_agent']);
    }

    public function testReasoningSummaryAutoPassesThrough(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.2',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "auto"', $rendered['content']);
    }

    public function testReasoningSummaryForcedDetailedForGpt51CodexModels(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.3-codex-spark',
            'model_reasoning_summary' => 'concise',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "detailed"', $rendered['content']);

        $rendered = $this->service->render([
            'model' => 'gpt-5.1-codex-mini',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "detailed"', $rendered['content']);

        $rendered = $this->service->render([
            'model' => 'gpt-5.2-codex',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "detailed"', $rendered['content']);
    }

    public function testVerbosityForcedMediumForGpt51CodexMax(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.1-codex-max',
            'model_verbosity' => 'low',
        ]);

        $this->assertStringContainsString('model_verbosity = "medium"', $rendered['content']);

        $renderedHigh = $this->service->render([
            'model' => 'gpt-5.1-codex-max',
            'model_verbosity' => 'high',
        ]);

        $this->assertStringContainsString('model_verbosity = "medium"', $renderedHigh['content']);

        $renderedAllowed = $this->service->render([
            'model' => 'gpt-5.2-codex',
            'model_verbosity' => 'high',
        ]);

        $this->assertStringContainsString('model_verbosity = "high"', $renderedAllowed['content']);
    }

    public function testUnsupportedModelIsDroppedFromRenderedConfig(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.1',
            'model_reasoning_effort' => 'high',
        ]);

        $this->assertStringNotContainsString('model = "gpt-5.1"', $rendered['content']);
        $this->assertStringNotContainsString('model_reasoning_effort = "high"', $rendered['content']);
        $this->assertNull($rendered['settings']['model']);
        $this->assertNull($rendered['settings']['model_reasoning_effort']);
    }

    public function testSparkModelSupportsXHighReasoningEffort(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.3-codex-spark',
            'model_reasoning_effort' => 'xhigh',
        ]);

        $this->assertStringContainsString('model = "gpt-5.3-codex-spark"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "xhigh"', $rendered['content']);
    }

    public function testStaticModelValidationHelpersUseSupportedAllowlist(): void
    {
        $this->assertSame(
            'gpt-5.3-codex-spark',
            ClientConfigService::normalizeSupportedModel('gpt-5.3-codex-spark')
        );
        $this->assertNull(ClientConfigService::normalizeSupportedModel('gpt-5.1'));
        $this->assertTrue(ClientConfigService::modelSupportsReasoningEffort('gpt-5.3-codex-spark', 'xhigh'));
        $this->assertFalse(ClientConfigService::modelSupportsReasoningEffort('gpt-5.1-codex-mini', 'low'));
    }

    public function testStorePersistsAndDetectsUnchanged(): void
    {
        $first = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
        $this->assertSame('created', $first['status']);
        $this->assertArrayHasKey('sha256', $first);
        $this->assertNotEmpty($this->repository->latest());

        $second = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
        $this->assertSame('unchanged', $second['status']);
        $this->assertCount(2, $this->logs->records); // store + store
    }

    public function testStoreRejectsMismatchedProvidedSha(): void
    {
        $created = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
        $this->assertSame('created', $created['status']);
        $currentSha = $created['sha256'];

        $wrongSha = str_repeat('b', 64);
        $this->assertNotSame($currentSha, $wrongSha);

        try {
            $this->service->store([
                'settings' => ['model' => 'gpt-5.2'],
                'sha256' => $wrongSha,
            ]);
            $this->fail('Expected store() to reject mismatched sha256');
        } catch (ValidationException $e) {
            $errors = $e->getErrors();
            $this->assertArrayHasKey('sha256', $errors);
            $this->assertContains('sha256 does not match current saved config.toml (reload before saving)', $errors['sha256']);
        }

        $updated = $this->service->store([
            'settings' => ['model' => 'gpt-5.2'],
            'sha256' => $currentSha,
        ]);
        $this->assertSame('updated', $updated['status']);
    }

    public function testRetrieveHonorsSha(): void
    {
        $stored = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
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
        $stored = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
        $baseSha = $stored['sha256'];

        $first = $this->service->retrieve(null, ['id' => 1], 'https://example.test', 'api-key-one');
        $second = $this->service->retrieve(null, ['id' => 1], 'https://example.test', 'api-key-two');

        $this->assertSame($baseSha, $first['base_sha256']);
        $this->assertSame($baseSha, $second['base_sha256']);
        $this->assertNotSame($first['sha256'], $second['sha256'], 'baked sha must change when API key changes');
    }

    public function testRetrieveInjectsTrustedProjectHome(): void
    {
        $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);

        $result = $this->service->retrieve(null, ['id' => 2], null, null, 'alice', '/home/alice');

        $this->assertArrayHasKey('content', $result);
        $this->assertStringContainsString('[projects."/home/alice"]', $result['content']);
        $this->assertStringContainsString('trust_level = "trusted"', $result['content']);
    }

    public function testRetrieveSkipsInvalidHomePath(): void
    {
        $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);

        $result = $this->service->retrieve(null, ['id' => 3], null, null, 'alice', 'home/alice');

        $this->assertArrayHasKey('content', $result);
        $this->assertStringNotContainsString('[projects."home/alice"]', $result['content']);
    }

    public function testBakedShaChangesWhenHomeChanges(): void
    {
        $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);

        $first = $this->service->retrieve(null, ['id' => 4], 'https://example.test', 'api-key', null, '/home/a');
        $second = $this->service->retrieve(null, ['id' => 4], 'https://example.test', 'api-key', null, '/home/b');

        $this->assertNotSame($first['sha256'], $second['sha256'], 'baked sha must change when home path changes');
    }

    public function testRenderForHostAppliesPerHostModelOverrides(): void
    {
        $rendered = $this->service->renderForHost([
            'model' => 'gpt-5.2',
            'model_reasoning_effort' => 'xhigh',
            'approval_policy' => 'on-request',
            'sandbox_mode' => 'workspace-write',
        ], [
            'id' => 1,
            'model_override' => 'gpt-5.1-codex-mini',
            'reasoning_effort_override' => 'medium',
        ], 'https://example.test', 'api-key-one');

        $this->assertStringContainsString('model = "gpt-5.1-codex-mini"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "medium"', $rendered['content']);
    }

    public function testStoreDetectsSettingsOnlyChange(): void
    {
        $first = $this->service->store(['settings' => ['model' => 'gpt-5.3-codex']]);
        $this->assertSame('created', $first['status']);

        $second = $this->service->store([
            'settings' => [
                'model' => 'gpt-5.3-codex',
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
        $this->assertStringContainsString('startup_timeout_sec = 30', $content);
        $this->assertStringContainsString('[mcp_servers.user-custom]', $content);
        $this->assertStringNotContainsString('mcp_servers.codex-memory', $content);
    }

    public function testRenderRendersProfilesWithFeaturesAndSandboxOverrides(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.2',
            'approval_policy' => 'on-request',
            'sandbox_mode' => 'workspace-write',
            'profiles' => [
                [
                    'name' => 'ultra',
                    'model' => 'gpt-5.1-codex-max',
                    'approval_policy' => 'on-request',
                    'sandbox_mode' => 'workspace-write',
                    'model_reasoning_effort' => 'xhigh',
                    'features' => [
                        'streamable_shell' => true,
                        'web_search' => 'cached',
                        'view_image_tool' => true,
                    ],
                    'sandbox_workspace_write' => [
                        'network_access' => true,
                    ],
                ],
            ],
        ]);

        $content = $rendered['content'];
        $this->assertStringContainsString('[profiles.ultra]', $content);
        $this->assertStringContainsString('model = "gpt-5.1-codex-max"', $content);
        $this->assertStringContainsString('web_search = "cached"', $content);
        $this->assertStringContainsString('[profiles.ultra.features]', $content);
        $this->assertStringContainsString('streamable_shell = true', $content);
        $this->assertStringContainsString('view_image_tool = true', $content);
        $this->assertStringContainsString('[profiles.ultra.sandbox_workspace_write]', $content);
        $this->assertStringContainsString('network_access = true', $content);

        $settings = $rendered['settings'];
        $this->assertIsArray($settings);
        $this->assertIsArray($settings['profiles']);
        $this->assertSame('ultra', $settings['profiles'][0]['name']);
        $this->assertSame(true, $settings['profiles'][0]['features']['streamable_shell']);
        $this->assertSame('cached', $settings['profiles'][0]['web_search']);
        $this->assertSame(true, $settings['profiles'][0]['sandbox_workspace_write']['network_access']);
    }
}
