<?php

declare(strict_types=1);

use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\PricingService;
use App\Services\UsageCostService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class UsageCostServiceTest extends TestCase
{
    public function testBackfillSkipsWhenAlreadyDone(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')->willReturn('2026-01-01T00:00:00Z');
        $versions->expects($this->never())->method('set');

        $tokenUsage = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['backfillCosts'])
            ->getMock();
        $tokenUsage->expects($this->never())->method('backfillCosts');

        $tokenIngest = $this->getMockBuilder(TokenUsageIngestRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['backfillCosts'])
            ->getMock();

        $pricing = $this->getMockBuilder(PricingService::class)
            ->disableOriginalConstructor()
            ->getMock();

        $service = new UsageCostService($tokenUsage, $tokenIngest, $pricing, $versions);
        $service->backfillMissingCosts();
    }

    public function testBackfillRunsWhenNotDone(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')->willReturn(null);
        $versions->expects($this->once())->method('set');

        $pricing = $this->getMockBuilder(PricingService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['latestPricing'])
            ->getMock();
        $pricing->method('latestPricing')->willReturn([
            'input_price_per_1k' => '0.010',
            'output_price_per_1k' => '0.030',
            'cached_price_per_1k' => '0.005',
        ]);

        $tokenUsage = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['backfillCosts'])
            ->getMock();
        $tokenUsage->expects($this->once())->method('backfillCosts')
            ->with(0.010, 0.030, 0.005);

        $tokenIngest = $this->getMockBuilder(TokenUsageIngestRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['backfillCosts'])
            ->getMock();
        $tokenIngest->expects($this->once())->method('backfillCosts')
            ->with(0.010, 0.030, 0.005);

        $service = new UsageCostService($tokenUsage, $tokenIngest, $pricing, $versions);
        $service->backfillMissingCosts();
    }

    public function testBackfillSurvivesPricingException(): void
    {
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')->willReturn(null);
        $versions->expects($this->never())->method('set');

        $pricing = $this->getMockBuilder(PricingService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['latestPricing'])
            ->getMock();
        $pricing->method('latestPricing')
            ->willThrowException(new RuntimeException('pricing unavailable'));

        $tokenUsage = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->getMock();
        $tokenIngest = $this->getMockBuilder(TokenUsageIngestRepository::class)
            ->disableOriginalConstructor()
            ->getMock();

        $service = new UsageCostService($tokenUsage, $tokenIngest, $pricing, $versions);
        // Should not throw — the service catches and logs
        $service->backfillMissingCosts();
        $this->assertTrue(true);
    }
}
