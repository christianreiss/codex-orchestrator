<?php

declare(strict_types=1);

use App\Repositories\VersionRepository;
use App\Services\ChatGptUsageService;
use App\Services\UsageScalingService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryVersionRepositoryForUsageScaling extends VersionRepository
{
    /** @var array<string, string> */
    private array $values = [];

    public function __construct()
    {
    }

    public function get(string $name): ?string
    {
        return $this->values[$name] ?? null;
    }

    public function set(string $name, string $version): void
    {
        $this->values[$name] = $version;
    }
}

final class StubChatGptUsageServiceForScaling extends ChatGptUsageService
{
    public function __construct()
    {
    }

    public function latestWindowSummary(): ?array
    {
        return [
            'active_quota_lane' => 'normal',
            'fetched_at' => gmdate(DATE_ATOM),
            'normal_window' => [
                'secondary_window' => [
                    'used_percent' => 70.0,
                    'limit_seconds' => 604800,
                    'reset_after_seconds' => 302400,
                    'reset_at' => gmdate(DATE_ATOM, time() + 302400),
                ],
            ],
            'spark_window' => [
                'secondary_window' => [
                    'used_percent' => 0.0,
                    'limit_seconds' => 604800,
                    'reset_after_seconds' => 604800,
                    'reset_at' => gmdate(DATE_ATOM, time() + 604800),
                ],
            ],
        ];
    }
}

final class UsageScalingServiceTest extends TestCase
{
    public function testDefaultTiersFollowRequestedDowngradeChainWithoutSpark(): void
    {
        $tiers = UsageScalingService::defaultTiers();

        $this->assertSame([
            ['projected_percent' => 80, 'reasoning_effort' => 'high', 'model' => 'gpt-5.4'],
            ['projected_percent' => 85, 'reasoning_effort' => 'high', 'model' => 'gpt-5.4-mini'],
            ['projected_percent' => 92, 'reasoning_effort' => 'high', 'model' => 'gpt-5.3-codex'],
            ['projected_percent' => 100, 'reasoning_effort' => 'medium', 'model' => 'gpt-5.3-codex'],
        ], $tiers);
    }

    public function testStoreRulesRejectsRemovedModelAsScalingTarget(): void
    {
        $service = new UsageScalingService(
            new StubChatGptUsageServiceForScaling(),
            new InMemoryVersionRepositoryForUsageScaling()
        );

        $errors = $service->storeRules([
            'enabled' => true,
            'tiers' => [
                ['projected_percent' => 90, 'reasoning_effort' => 'high', 'model' => 'gpt-5.3-codex-spark'],
            ],
            'vip_exempt' => true,
            'host_override_wins' => true,
        ]);

        $this->assertNotEmpty($errors);
        $this->assertContains('tiers[0].model must be one of: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2', $errors);
    }
}
