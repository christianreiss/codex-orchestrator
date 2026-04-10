<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\ClaudeUsageService;
use PHPUnit\Framework\TestCase;

final class ClaudeUsageServiceTest extends TestCase
{
    public function testModelPricingReturnsArrayForAllThreeModels(): void
    {
        $pricing = ClaudeUsageService::modelPricing();

        $this->assertIsArray($pricing);
        $keys = array_keys($pricing);
        $joined = implode(' ', $keys);

        $hasOpus = str_contains($joined, 'opus');
        $hasSonnet = str_contains($joined, 'sonnet');
        $hasHaiku = str_contains($joined, 'haiku');

        $this->assertTrue(
            ($hasOpus && $hasSonnet && $hasHaiku) || count($pricing) >= 3,
            'Expected pricing entries for at least three model families (opus, sonnet, haiku)'
        );
    }

    public function testModelPricingContainsRequiredPriceKeys(): void
    {
        $pricing = ClaudeUsageService::modelPricing();

        foreach ($pricing as $model => $prices) {
            $this->assertIsArray($prices, "Pricing for {$model} should be an array");
            $this->assertArrayHasKey('input', $prices, "Missing input for {$model}");
            $this->assertArrayHasKey('output', $prices, "Missing output for {$model}");
            $this->assertArrayHasKey('cached', $prices, "Missing cached for {$model}");
        }
    }

    public function testCalculateCostForOpusModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-opus-4-6', 1000, 500);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostForSonnetModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-sonnet-4-6', 1000, 500);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostForHaikuModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-haiku-4-5', 1000, 500);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostHaikuCheaperThanSonnetCheaperThanOpus(): void
    {
        $inputTokens = 10000;
        $outputTokens = 5000;

        $pricing = ClaudeUsageService::modelPricing();
        $modelKeys = array_keys($pricing);

        $opusModel = null;
        $sonnetModel = null;
        $haikuModel = null;
        foreach ($modelKeys as $key) {
            if (str_contains($key, 'opus') && $opusModel === null) {
                $opusModel = $key;
            }
            if (str_contains($key, 'sonnet') && $sonnetModel === null) {
                $sonnetModel = $key;
            }
            if (str_contains($key, 'haiku') && $haikuModel === null) {
                $haikuModel = $key;
            }
        }

        if ($opusModel === null || $sonnetModel === null || $haikuModel === null) {
            $this->markTestSkipped('Need all three model tiers for price comparison');
        }

        $opusCost = ClaudeUsageService::calculateCost($opusModel, $inputTokens, $outputTokens);
        $sonnetCost = ClaudeUsageService::calculateCost($sonnetModel, $inputTokens, $outputTokens);
        $haikuCost = ClaudeUsageService::calculateCost($haikuModel, $inputTokens, $outputTokens);

        $this->assertGreaterThan($sonnetCost, $opusCost, 'Opus should be more expensive than Sonnet');
        $this->assertGreaterThan($haikuCost, $sonnetCost, 'Sonnet should be more expensive than Haiku');
    }

    public function testCalculateCostWithCachedTokens(): void
    {
        $costWithoutCache = ClaudeUsageService::calculateCost('claude-sonnet-4-6', 1000, 500);

        $costWithCache = ClaudeUsageService::calculateCost('claude-sonnet-4-6', 500, 500, 500);

        $this->assertIsFloat($costWithCache);
        $this->assertGreaterThan(0.0, $costWithCache);
        // Cached input tokens are discounted vs regular input tokens
        $this->assertLessThanOrEqual($costWithoutCache, $costWithCache);
    }

    public function testCalculateCostFallsBackToSonnetPricingForUnknownModel(): void
    {
        $unknownCost = ClaudeUsageService::calculateCost('claude-unknown-model', 1000, 500);

        $sonnetCost = ClaudeUsageService::calculateCost('claude-sonnet-4-6', 1000, 500);

        $this->assertIsFloat($unknownCost);
        $this->assertGreaterThan(0.0, $unknownCost);
        $this->assertSame($sonnetCost, $unknownCost);
    }

    public function testCalculateCostWithZeroTokensReturnsZero(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-sonnet-4-6', 0, 0);

        $this->assertSame(0.0, $cost);
    }

    public function testHistoryMethodExists(): void
    {
        $this->assertTrue(
            method_exists(ClaudeUsageService::class, 'history'),
            'ClaudeUsageService must have a history() method'
        );

        $ref = new ReflectionMethod(ClaudeUsageService::class, 'history');
        $params = $ref->getParameters();

        $names = array_map(fn (ReflectionParameter $p) => $p->getName(), $params);
        $this->assertContains('bucket', $names, 'history() should accept a bucket parameter');
        $this->assertContains('period', $names, 'history() should accept a period parameter');
        $this->assertContains('model', $names, 'history() should accept a model parameter');
    }

    public function testHistoryAdvancedMethodExists(): void
    {
        $this->assertTrue(
            method_exists(ClaudeUsageService::class, 'historyAdvanced'),
            'ClaudeUsageService must have a historyAdvanced() method'
        );

        $ref = new ReflectionMethod(ClaudeUsageService::class, 'historyAdvanced');
        $params = $ref->getParameters();

        $names = array_map(fn (ReflectionParameter $p) => $p->getName(), $params);
        $this->assertContains('bucket', $names, 'historyAdvanced() should accept a bucket parameter');
        $this->assertContains('period', $names, 'historyAdvanced() should accept a period parameter');
    }

    public function testStoreErrorMethodExists(): void
    {
        $this->assertTrue(
            method_exists(ClaudeUsageService::class, 'storeError'),
            'ClaudeUsageService must have a storeError() method'
        );

        $ref = new ReflectionMethod(ClaudeUsageService::class, 'storeError');
        $params = $ref->getParameters();

        $names = array_map(fn (ReflectionParameter $p) => $p->getName(), $params);
        $this->assertContains('message', $names, 'storeError() should accept a message parameter');
        $this->assertContains('context', $names, 'storeError() should accept a context parameter');
    }

    public function testShouldRefreshMethodExists(): void
    {
        $this->assertTrue(
            method_exists(ClaudeUsageService::class, 'shouldRefresh'),
            'ClaudeUsageService must have a shouldRefresh() method'
        );

        $ref = new ReflectionMethod(ClaudeUsageService::class, 'shouldRefresh');
        $returnType = $ref->getReturnType();
        $this->assertNotNull($returnType, 'shouldRefresh() should have a return type');
        $this->assertSame('bool', $returnType->getName(), 'shouldRefresh() should return bool');
    }

    public function testHistoryReturnsEmptyArrayWithoutDatabase(): void
    {
        $service = $this->createService();

        $result = $service->history();
        $this->assertIsArray($result);
        $this->assertEmpty($result);
    }

    public function testHistoryAdvancedReturnsEmptySeriesWithoutDatabase(): void
    {
        $service = $this->createService();

        $result = $service->historyAdvanced();
        $this->assertIsArray($result);
        $this->assertArrayHasKey('series', $result);
        $this->assertArrayHasKey('totals', $result);
        $this->assertEmpty($result['series']);
        $this->assertEmpty($result['totals']);
    }

    public function testLatestUsageSummaryReturnsNullWhenNoSnapshot(): void
    {
        $service = $this->createService();

        $summary = $service->latestUsageSummary();
        $this->assertNull($summary);
    }

    public function testDashboardSummaryReturnsAllTimeWindows(): void
    {
        $service = $this->createService();

        $summary = $service->dashboardSummary();
        $this->assertIsArray($summary);
        $this->assertArrayHasKey('current_spend', $summary);
        $this->assertArrayHasKey('usage_24h', $summary);
        $this->assertArrayHasKey('usage_7d', $summary);
        $this->assertArrayHasKey('usage_30d', $summary);
        $this->assertArrayHasKey('total_cost_24h', $summary);
        $this->assertArrayHasKey('total_cost_7d', $summary);
        $this->assertArrayHasKey('total_cost_30d', $summary);
    }

    public function testMinRefreshSecondsConstantIsDefined(): void
    {
        $reflection = new ReflectionClass(ClaudeUsageService::class);

        $this->assertTrue(
            $reflection->hasConstant('MIN_REFRESH_SECONDS'),
            'ClaudeUsageService must define MIN_REFRESH_SECONDS constant'
        );

        $constant = $reflection->getReflectionConstant('MIN_REFRESH_SECONDS');
        $this->assertSame(300, $constant->getValue(), 'MIN_REFRESH_SECONDS should be 300');
    }

    public function testShouldRefreshReturnsTrueWhenNeverRefreshed(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')
            ->with('claude_usage_last_refresh')
            ->willReturn(null);

        $service = $this->createService($versions);
        $this->assertTrue($service->shouldRefresh());
    }

    public function testShouldRefreshReturnsFalseWhenRecentlyRefreshed(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')
            ->with('claude_usage_last_refresh')
            ->willReturn((string) time());

        $service = $this->createService($versions);
        $this->assertFalse($service->shouldRefresh());
    }

    public function testShouldRefreshReturnsTrueWhenStale(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')
            ->with('claude_usage_last_refresh')
            ->willReturn((string) (time() - 600));

        $service = $this->createService($versions);
        $this->assertTrue($service->shouldRefresh());
    }

    public function testStoreErrorCallsLogRepository(): void
    {
        $logs = $this->createMock(LogRepository::class);
        $logs->expects($this->once())
            ->method('log')
            ->with(
                null,
                'claude.usage.error',
                $this->callback(function (array $details): bool {
                    return ($details['message'] ?? '') === 'test error'
                        && ($details['code'] ?? '') === '42';
                })
            );

        $service = $this->createService(null, $logs);
        $service->storeError('test error', ['code' => '42']);
    }

    private function createService(?VersionRepository $versions = null, ?LogRepository $logs = null): ClaudeUsageService
    {
        $versions ??= $this->createMock(VersionRepository::class);
        $logs ??= $this->createMock(LogRepository::class);

        return new ClaudeUsageService($versions, $logs);
    }
}
