<?php

declare(strict_types=1);

use App\Repositories\TokenUsageRepository;
use App\Services\CostHistoryService;
use App\Services\PricingService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class CostHistoryServiceTest extends TestCase
{
    public function testHistoryAdvancedSupportsWeeklyIntervalAndTotalGrouping(): void
    {
        $tokenUsageRepository = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['firstRecordedAt', 'dailyTotalsSince'])
            ->getMock();

        $tokenUsageRepository->method('firstRecordedAt')->willReturn('2026-01-01T00:00:00Z');
        $tokenUsageRepository->method('dailyTotalsSince')->willReturn([
            ['date' => '2026-01-01', 'input' => 1000, 'output' => 500, 'cached' => 200],
            ['date' => '2026-01-02', 'input' => 2000, 'output' => 400, 'cached' => 300],
            ['date' => '2026-01-08', 'input' => 3000, 'output' => 800, 'cached' => 600],
        ]);

        $pricingService = $this->getMockBuilder(PricingService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['latestPricing'])
            ->getMock();

        $pricingService->method('latestPricing')->willReturn([
            'currency' => 'USD',
            'input_price_per_1k' => 0.01,
            'output_price_per_1k' => 0.02,
            'cached_price_per_1k' => 0.005,
        ]);

        $service = new CostHistoryService($tokenUsageRepository, $pricingService, 'gpt-5.1');
        $history = $service->historyAdvanced(
            30,
            '2026-01-01T00:00:00Z',
            '2026-01-10T00:00:00Z',
            'week',
            'total',
            false
        );

        $this->assertSame('week', $history['interval']);
        $this->assertSame('total', $history['group_by']);
        $this->assertFalse($history['include_tokens']);
        $this->assertNotEmpty($history['points']);
        $this->assertArrayNotHasKey('tokens', $history['points'][0]);
        $this->assertCount(1, $history['series']);
        $this->assertSame('total', $history['series'][0]['key']);
        $this->assertNotEmpty($history['series'][0]['points']);
    }
}
