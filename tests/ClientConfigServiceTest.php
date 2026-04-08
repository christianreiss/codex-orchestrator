<?php

declare(strict_types=1);

use App\Repositories\ClientConfigRepository;
use App\Repositories\LogRepository;
use App\Repositories\McpSessionTokenRepository;
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

final class SpyMcpSessionTokenRepository extends McpSessionTokenRepository
{
    public array $issued = [];

    public function __construct()
    {
    }

    public function create(string $token, int $hostId, string $expiresAt): array
    {
        $this->issued[] = [
            'token' => $token,
            'host_id' => $hostId,
            'expires_at' => $expiresAt,
        ];

        return [
            'id' => count($this->issued),
            'token' => $token,
            'host_id' => $hostId,
            'expires_at' => $expiresAt,
        ];
    }

    public function deleteExpired(string $cutoff): void
    {
        // no-op for tests
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
                    'gpt-5.3-codex-spark' => 'gpt-5.4',
                ],
            ],
            'features' => [
                'web_search' => 'live',
            ],
        ]);

        $this->assertNotEmpty($rendered['content']);
        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "medium"', $rendered['content']);
        $this->assertStringContainsString('model_provider = "oss"', $rendered['content']);
        $this->assertStringContainsString('local_provider = "ollama"', $rendered['content']);
        $this->assertStringContainsString('approval_policy = "on-request"', $rendered['content']);
        $this->assertStringContainsString('web_search = "live"', $rendered['content']);
        $this->assertStringContainsString('[notice]', $rendered['content']);
        $this->assertStringContainsString('[security]', $rendered['content']);
        $this->assertStringContainsString('dangerously_bypass_approvals_and_sandbox = true', $rendered['content']);
        $this->assertStringContainsString('hide_gpt5_1_migration_prompt = true', $rendered['content']);
        $this->assertStringContainsString('"gpt-5.2-codex" = "gpt-5.3-codex"', $rendered['content']);
        $this->assertStringContainsString('"gpt-5.3-codex-spark" = "gpt-5.4"', $rendered['content']);
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

    public function testDefaultNoticeModelMigrationsIncludeGpt54UpgradePath(): void
    {
        $rendered = $this->service->render([]);

        $this->assertStringContainsString('personality = "friendly"', $rendered['content']);
        $this->assertSame('friendly', $rendered['settings']['personality']);
        $this->assertStringContainsString('"gpt-5.1-codex-max" = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('"gpt-5.3-codex-spark" = "gpt-5.4"', $rendered['content']);
    }

    public function testExplicitPersonalityRendersAtRoot(): void
    {
        $rendered = $this->service->render([
            'personality' => 'pragmatic',
        ]);

        $this->assertStringContainsString('personality = "pragmatic"', $rendered['content']);
        $this->assertSame('pragmatic', $rendered['settings']['personality']);
    }

    public function testExplicitPersonalityAllowsNone(): void
    {
        $rendered = $this->service->render([
            'personality' => 'none',
        ]);

        $this->assertStringContainsString('personality = "none"', $rendered['content']);
        $this->assertSame('none', $rendered['settings']['personality']);
    }

    public function testNoticeModelMigrationsBackfillsDefaultsForLegacySavedMap(): void
    {
        $rendered = $this->service->render([
            'notice' => [
                'model_migrations' => [
                    'gpt-5.2-codex' => 'gpt-5.3-codex',
                ],
            ],
        ]);

        $this->assertStringContainsString('"gpt-5.2-codex" = "gpt-5.3-codex"', $rendered['content']);
        $this->assertStringContainsString('"gpt-5.3-codex-spark" = "gpt-5.4"', $rendered['content']);
        $this->assertSame('gpt-5.4', $rendered['settings']['notice']['model_migrations']['gpt-5.3-codex-spark']);
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

    public function testLegacyWebSearchCachedMapsToCachedWebSearch(): void
    {
        $rendered = $this->service->render([
            'features' => [
                'web_search_cached' => true,
            ],
        ]);

        $this->assertStringContainsString('web_search = "cached"', $rendered['content']);
        $this->assertArrayHasKey('web_search', $rendered['settings']);
        $this->assertSame('cached', $rendered['settings']['web_search']);
        $this->assertArrayNotHasKey('web_search_cached', $rendered['settings']['features']);
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

    public function testRemovedAndUnknownFeatureKeysAreIgnoredWhileKnownFlagsPersist(): void
    {
        $rendered = $this->service->render([
            'features' => [
                'fast_mode' => true,
                'voice_transcription' => true,
                'collaboration_modes' => true,
                'elevated_windows_sandbox' => true,
                'remote_models' => true,
                'request_rule' => true,
                'search_tool' => true,
                'steer' => true,
                'experimental_windows_sandbox' => true,
                'enable_experimental_windows_sandbox' => true,
                'request_permissions' => true,
                'personality' => true,
                'request_permissions_tool' => true,
                'tui_app_server' => true,
                'use_legacy_landlock' => true,
                'use_linux_sandbox_bwrap' => true,
                'ghost_commit' => true,
            ],
            'steer' => true,
        ]);

        $this->assertStringContainsString('personality = "friendly"', $rendered['content']);
        $this->assertStringContainsString('[features]', $rendered['content']);
        $this->assertStringContainsString('fast_mode = true', $rendered['content']);
        $this->assertStringContainsString('voice_transcription = true', $rendered['content']);
        $this->assertStringNotContainsString('collaboration_modes =', $rendered['content']);
        $this->assertStringNotContainsString('elevated_windows_sandbox =', $rendered['content']);
        $this->assertStringNotContainsString('remote_models =', $rendered['content']);
        $this->assertStringNotContainsString('request_rule =', $rendered['content']);
        $this->assertStringNotContainsString('search_tool =', $rendered['content']);
        $this->assertStringNotContainsString('steer =', $rendered['content']);
        $this->assertStringNotContainsString('experimental_windows_sandbox =', $rendered['content']);
        $this->assertStringNotContainsString('enable_experimental_windows_sandbox =', $rendered['content']);
        $this->assertStringNotContainsString('request_permissions =', $rendered['content']);
        $this->assertStringNotContainsString('use_linux_sandbox_bwrap =', $rendered['content']);
        $this->assertStringContainsString('personality = true', $rendered['content']);
        $this->assertStringContainsString('request_permissions_tool = true', $rendered['content']);
        $this->assertStringContainsString('tui_app_server = true', $rendered['content']);
        $this->assertStringContainsString('use_legacy_landlock = true', $rendered['content']);
        $this->assertStringNotContainsString('ghost_commit =', $rendered['content']);
        $this->assertArrayHasKey('fast_mode', $rendered['settings']['features']);
        $this->assertArrayHasKey('personality', $rendered['settings']['features']);
        $this->assertSame(true, $rendered['settings']['features']['personality']);
        $this->assertArrayHasKey('request_permissions_tool', $rendered['settings']['features']);
        $this->assertSame(true, $rendered['settings']['features']['request_permissions_tool']);
        $this->assertArrayHasKey('tui_app_server', $rendered['settings']['features']);
        $this->assertSame(true, $rendered['settings']['features']['tui_app_server']);
        $this->assertArrayHasKey('use_legacy_landlock', $rendered['settings']['features']);
        $this->assertSame(true, $rendered['settings']['features']['use_legacy_landlock']);
        $this->assertArrayHasKey('voice_transcription', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('collaboration_modes', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('elevated_windows_sandbox', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('remote_models', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('request_permissions', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('request_rule', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('search_tool', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('steer', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('experimental_windows_sandbox', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('enable_experimental_windows_sandbox', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('use_linux_sandbox_bwrap', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('ghost_commit', $rendered['settings']['features']);
        $this->assertArrayNotHasKey('steer', $rendered['settings']);
    }

    public function testFeatureDefaultsMatchBuilderPolicy(): void
    {
        $renderedDefault = $this->service->render([]);
        $this->assertStringContainsString('[features]', $renderedDefault['content']);
        $this->assertStringContainsString('apps = true', $renderedDefault['content']);
        $this->assertSame(true, $renderedDefault['settings']['features']['apps']);
        $this->assertStringContainsString('multi_agent = true', $renderedDefault['content']);
        $this->assertSame(true, $renderedDefault['settings']['features']['multi_agent']);
        $this->assertArrayNotHasKey('guardian_approval', $renderedDefault['settings']['features']);
        $this->assertArrayNotHasKey('js_repl', $renderedDefault['settings']['features']);
        $this->assertArrayNotHasKey('tui_app_server', $renderedDefault['settings']['features']);
        $this->assertArrayNotHasKey('prevent_idle_sleep', $renderedDefault['settings']['features']);

        $renderedCustom = $this->service->render([
            'features' => [
                'apps' => true,
                'guardian_approval' => false,
                'js_repl' => false,
                'tui_app_server' => false,
                'prevent_idle_sleep' => false,
                'multi_agent' => true,
            ],
        ]);
        $this->assertStringContainsString('[features]', $renderedCustom['content']);
        $this->assertStringContainsString('apps = true', $renderedCustom['content']);
        $this->assertSame(true, $renderedCustom['settings']['features']['apps']);
        $this->assertStringContainsString('guardian_approval = false', $renderedCustom['content']);
        $this->assertSame(false, $renderedCustom['settings']['features']['guardian_approval']);
        $this->assertStringContainsString('js_repl = false', $renderedCustom['content']);
        $this->assertSame(false, $renderedCustom['settings']['features']['js_repl']);
        $this->assertStringContainsString('tui_app_server = false', $renderedCustom['content']);
        $this->assertSame(false, $renderedCustom['settings']['features']['tui_app_server']);
        $this->assertStringContainsString('prevent_idle_sleep = false', $renderedCustom['content']);
        $this->assertSame(false, $renderedCustom['settings']['features']['prevent_idle_sleep']);
        $this->assertStringContainsString('multi_agent = true', $renderedCustom['content']);
        $this->assertSame(true, $renderedCustom['settings']['features']['multi_agent']);
    }

    public function testReasoningSummaryAutoPassesThrough(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.4',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "auto"', $rendered['content']);
    }

    public function testGpt54SupportsFullReasoningEffortRange(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.4',
            'model_reasoning_effort' => 'xhigh',
        ]);

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "xhigh"', $rendered['content']);
    }

    public function testGpt54MiniSupportsFullReasoningEffortRange(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.4-mini',
            'model_reasoning_effort' => 'xhigh',
        ]);

        $this->assertStringContainsString('model = "gpt-5.4-mini"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "xhigh"', $rendered['content']);
    }

    public function testReasoningSummaryOmittedForSparkAndForcedDetailedForCodexModels(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.3-codex-spark',
            'model_reasoning_summary' => 'concise',
        ]);

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "medium"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_summary = "concise"', $rendered['content']);

        $rendered = $this->service->render([
            'model' => 'gpt-5.3-codex',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model_reasoning_summary = "detailed"', $rendered['content']);

        $rendered = $this->service->render([
            'model' => 'gpt-5.2-codex',
            'model_reasoning_summary' => 'auto',
        ]);

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "medium"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_summary = "auto"', $rendered['content']);
    }

    public function testVerbosityForcedMediumForGpt51CodexMax(): void
    {
        $rendered = $this->service->render([
            'model' => 'gpt-5.1-codex-max',
            'model_verbosity' => 'low',
        ]);

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_verbosity = "low"', $rendered['content']);

        $renderedHigh = $this->service->render([
            'model' => 'gpt-5.1-codex-max',
            'model_verbosity' => 'high',
        ]);

        $this->assertStringContainsString('model_verbosity = "high"', $renderedHigh['content']);

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

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
        $this->assertStringContainsString('model_reasoning_effort = "medium"', $rendered['content']);
    }

    public function testStaticModelValidationHelpersUseSupportedAllowlist(): void
    {
        $this->assertSame(
            'gpt-5.4',
            ClientConfigService::normalizeSupportedModel('gpt-5.4')
        );
        $this->assertSame(
            'gpt-5.4-mini',
            ClientConfigService::normalizeSupportedModel('gpt-5.4-mini')
        );
        $this->assertNull(ClientConfigService::normalizeSupportedModel('gpt-5.3-codex-spark'));
        $this->assertNull(ClientConfigService::normalizeSupportedModel('gpt-5.1'));
        $this->assertTrue(ClientConfigService::modelSupportsReasoningEffort('gpt-5.4', 'xhigh'));
        $this->assertTrue(ClientConfigService::modelSupportsReasoningEffort('gpt-5.4-mini', 'xhigh'));
        $this->assertTrue(ClientConfigService::modelSupportsReasoningEffort('gpt-5.2', 'xhigh'));
        $this->assertFalse(ClientConfigService::modelSupportsReasoningEffort('gpt-5.3-codex-spark', 'low'));
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

        $this->assertStringContainsString('model = "gpt-5.4"', $rendered['content']);
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

    public function testRenderForInsecureHostUsesEphemeralManagedMcpToken(): void
    {
        $tokens = new SpyMcpSessionTokenRepository();
        $service = new ClientConfigService($this->repository, $this->logs, null, $tokens);

        $rendered = $service->renderForHost(
            [
                'mcp_servers' => [
                    ['name' => 'user-custom', 'command' => '/bin/echo'],
                ],
            ],
            ['id' => 12, 'secure' => 0],
            'https://coord.example',
            'abc123'
        );

        $content = $rendered['content'];
        $this->assertNotEmpty($tokens->issued);
        $token = $tokens->issued[0]['token'] ?? '';
        $this->assertIsString($token);
        $this->assertStringStartsWith('mcp_', $token);
        $this->assertStringContainsString('Authorization = "Bearer ' . $token . '"', $content);
        $this->assertStringNotContainsString('Authorization = "Bearer abc123"', $content);
        $this->assertStringContainsString('[mcp_servers.user-custom]', $content);
    }

    public function testRetrieveForInsecureHostBypassesBakeCacheAndRotatesManagedMcpToken(): void
    {
        $tokens = new SpyMcpSessionTokenRepository();
        $service = new ClientConfigService($this->repository, $this->logs, null, $tokens);
        $this->repository->upsert('body', [
            'mcp_servers' => [
                ['name' => 'user-custom', 'command' => '/bin/echo'],
            ],
        ]);

        $host = ['id' => 12, 'secure' => 0];
        $first = $service->retrieve(null, $host, 'https://coord.example', 'abc123');
        $firstToken = $tokens->issued[0]['token'] ?? '';

        $this->assertSame('updated', $first['status']);
        $this->assertIsString($firstToken);
        $this->assertStringStartsWith('mcp_', $firstToken);
        $this->assertStringContainsString('Authorization = "Bearer ' . $firstToken . '"', $first['content'] ?? '');

        $second = $service->retrieve($first['sha256'] ?? null, $host, 'https://coord.example', 'abc123');
        $secondToken = $tokens->issued[1]['token'] ?? '';

        $this->assertCount(2, $tokens->issued);
        $this->assertIsString($secondToken);
        $this->assertStringStartsWith('mcp_', $secondToken);
        $this->assertNotSame($firstToken, $secondToken);
        $this->assertSame('updated', $second['status']);
        $this->assertStringContainsString('Authorization = "Bearer ' . $secondToken . '"', $second['content'] ?? '');
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
                    'personality' => 'pragmatic',
                    'model_reasoning_effort' => 'xhigh',
                    'features' => [
                        'fast_mode' => true,
                        'web_search' => 'cached',
                        'unified_exec' => true,
                    ],
                    'sandbox_workspace_write' => [
                        'network_access' => true,
                    ],
                ],
            ],
        ]);

        $content = $rendered['content'];
        $this->assertStringContainsString('[profiles.ultra]', $content);
        $this->assertStringContainsString('model = "gpt-5.4"', $content);
        $this->assertStringContainsString('personality = "pragmatic"', $content);
        $this->assertStringContainsString('web_search = "cached"', $content);
        $this->assertStringContainsString('[profiles.ultra.features]', $content);
        $this->assertStringContainsString('fast_mode = true', $content);
        $this->assertStringContainsString('unified_exec = true', $content);
        $this->assertStringContainsString('[profiles.ultra.sandbox_workspace_write]', $content);
        $this->assertStringContainsString('network_access = true', $content);

        $settings = $rendered['settings'];
        $this->assertIsArray($settings);
        $this->assertIsArray($settings['profiles']);
        $this->assertSame('ultra', $settings['profiles'][0]['name']);
        $this->assertSame('pragmatic', $settings['profiles'][0]['personality']);
        $this->assertSame(true, $settings['profiles'][0]['features']['fast_mode']);
        $this->assertSame('cached', $settings['profiles'][0]['web_search']);
        $this->assertSame(true, $settings['profiles'][0]['sandbox_workspace_write']['network_access']);
        $this->assertSame('gpt-5.4', $settings['profiles'][0]['model']);
        $this->assertSame('medium', $settings['profiles'][0]['model_reasoning_effort']);
    }
}
