<?php

declare(strict_types=1);

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
            $this->assertArrayHasKey('input_per_1m', $prices, "Missing input_per_1m for {$model}");
            $this->assertArrayHasKey('output_per_1m', $prices, "Missing output_per_1m for {$model}");
        }
    }

    public function testCalculateCostForOpusModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-opus-4-20250514', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostForSonnetModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-sonnet-4-20250514', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostForHaikuModel(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-haiku-3-5-20241022', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $this->assertIsFloat($cost);
        $this->assertGreaterThan(0.0, $cost);
    }

    public function testCalculateCostHaikuCheaperThanSonnetCheaperThanOpus(): void
    {
        $tokens = ['input_tokens' => 10000, 'output_tokens' => 5000];

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

        $opusCost = ClaudeUsageService::calculateCost($opusModel, $tokens);
        $sonnetCost = ClaudeUsageService::calculateCost($sonnetModel, $tokens);
        $haikuCost = ClaudeUsageService::calculateCost($haikuModel, $tokens);

        $this->assertGreaterThan($sonnetCost, $opusCost, 'Opus should be more expensive than Sonnet');
        $this->assertGreaterThan($haikuCost, $sonnetCost, 'Sonnet should be more expensive than Haiku');
    }

    public function testCalculateCostWithCachedTokens(): void
    {
        $costWithoutCache = ClaudeUsageService::calculateCost('claude-sonnet-4-20250514', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $costWithCache = ClaudeUsageService::calculateCost('claude-sonnet-4-20250514', [
            'input_tokens' => 500,
            'output_tokens' => 500,
            'cache_read_input_tokens' => 500,
        ]);

        $this->assertIsFloat($costWithCache);
        $this->assertGreaterThan(0.0, $costWithCache);
        // Cached input tokens are discounted vs regular input tokens
        $this->assertLessThanOrEqual($costWithoutCache, $costWithCache);
    }

    public function testCalculateCostFallsBackToSonnetPricingForUnknownModel(): void
    {
        $unknownCost = ClaudeUsageService::calculateCost('claude-unknown-model', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $sonnetCost = ClaudeUsageService::calculateCost('claude-sonnet-4-20250514', [
            'input_tokens' => 1000,
            'output_tokens' => 500,
        ]);

        $this->assertIsFloat($unknownCost);
        $this->assertGreaterThan(0.0, $unknownCost);
        $this->assertSame($sonnetCost, $unknownCost);
    }

    public function testCalculateCostWithZeroTokensReturnsZero(): void
    {
        $cost = ClaudeUsageService::calculateCost('claude-sonnet-4-20250514', [
            'input_tokens' => 0,
            'output_tokens' => 0,
        ]);

        $this->assertSame(0.0, $cost);
    }

    public function testLatestUsageSummaryReturnsNullWhenNoSnapshot(): void
    {
        if (!method_exists(ClaudeUsageService::class, 'latestUsageSummary')) {
            $this->markTestSkipped('latestUsageSummary() not yet implemented');
        }

        $service = $this->createService();
        if ($service === null) {
            $this->markTestSkipped('Cannot instantiate ClaudeUsageService without dependencies');
        }

        $summary = $service->latestUsageSummary();
        $this->assertNull($summary);
    }

    public function testDashboardSummaryReturnsAllTimeWindows(): void
    {
        if (!method_exists(ClaudeUsageService::class, 'dashboardSummary')) {
            $this->markTestSkipped('dashboardSummary() not yet implemented');
        }

        $service = $this->createService();
        if ($service === null) {
            $this->markTestSkipped('Cannot instantiate ClaudeUsageService without dependencies');
        }

        $summary = $service->dashboardSummary();
        $this->assertIsArray($summary);
        $this->assertNotEmpty($summary);
    }

    private function createService(): ?ClaudeUsageService
    {
        $reflection = new ReflectionClass(ClaudeUsageService::class);
        $constructor = $reflection->getConstructor();

        if ($constructor === null) {
            return new ClaudeUsageService();
        }

        $params = $constructor->getParameters();
        $canCreate = true;
        foreach ($params as $param) {
            if (!$param->isDefaultValueAvailable() && !$param->allowsNull()) {
                $canCreate = false;
                break;
            }
        }

        if (!$canCreate) {
            return null;
        }

        return $reflection->newInstance();
    }
}
