<?php

declare(strict_types=1);

use App\Repositories\TokenUsageRepository;
use App\Services\CostHistoryService;
use App\Services\DashboardGraphStatsService;
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

        $service = new CostHistoryService($tokenUsageRepository, $pricingService, 'gpt-5.4');
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

    public function testHistoryUsesSetAsideGraphStatsWhenAvailable(): void
    {
        $tokenUsageRepository = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['firstRecordedAt', 'dailyTotalsSince'])
            ->getMock();

        $tokenUsageRepository->method('firstRecordedAt')->willReturn(null);
        $tokenUsageRepository->expects($this->never())->method('dailyTotalsSince');

        $graphStats = $this->getMockBuilder(DashboardGraphStatsService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['firstUsageRecordedAt', 'usageDailySince'])
            ->getMock();

        $graphStats->method('firstUsageRecordedAt')->willReturn('2026-01-02T00:00:00Z');
        $graphStats->method('usageDailySince')->willReturn([
            ['date' => '2026-01-02', 'total' => 1700, 'input' => 1000, 'output' => 500, 'cached' => 200, 'cost' => 0.021],
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

        $service = new CostHistoryService($tokenUsageRepository, $pricingService, 'gpt-5.4', $graphStats);
        $history = $service->historyAdvanced(
            7,
            '2026-01-02T00:00:00Z',
            '2026-01-02T00:00:00Z',
            'day',
            'component',
            true
        );

        $this->assertCount(1, $history['points']);
        $this->assertSame(1700, $history['points'][0]['tokens']['total']);
        $this->assertSame(0.021, $history['points'][0]['costs']['total']);
    }
}
