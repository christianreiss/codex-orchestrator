<?php

declare(strict_types=1);

use App\Repositories\ChatGptUsageStore;
use App\Repositories\DashboardGraphStatsRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\DashboardGraphStatsService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class DashboardGraphStatsServiceTest extends TestCase
{
    public function testFirstReadTriggersOneTimeBackfillWhenBootBackfillsAreDisabled(): void
    {
        $repository = $this->getMockBuilder(DashboardGraphStatsRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['upsertUsageDaily', 'recordQuotaSnapshot', 'firstUsageRecordedAt'])
            ->getMock();
        $repository->expects($this->once())
            ->method('upsertUsageDaily')
            ->with($this->callback(static function (array $usage): bool {
                return $usage['date'] === '2026-01-01'
                    && $usage['total'] === 1700
                    && $usage['input'] === 1000
                    && $usage['output'] === 500
                    && $usage['cached'] === 200
                    && $usage['reasoning'] === 50;
            }));
        $repository->expects($this->once())
            ->method('recordQuotaSnapshot')
            ->with($this->callback(static function (array $snapshot): bool {
                return ($snapshot['fetched_at'] ?? null) === '2026-01-01T12:00:00Z'
                    && ($snapshot['primary_used_percent'] ?? null) === 18;
            }));
        $repository->method('firstUsageRecordedAt')->willReturn('2026-01-01T00:00:00Z');

        $tokenUsages = $this->getMockBuilder(TokenUsageRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['firstRecordedAt', 'dailyTotalsSince'])
            ->getMock();
        $tokenUsages->method('firstRecordedAt')->willReturn('2026-01-01T00:00:00Z');
        $tokenUsages->expects($this->once())
            ->method('dailyTotalsSince')
            ->with('2026-01-01T00:00:00Z')
            ->willReturn([
                [
                    'date' => '2026-01-01',
                    'input' => 1000,
                    'output' => 500,
                    'cached' => 200,
                    'reasoning' => 50,
                ],
            ]);

        $chatGptUsageStore = $this->getMockBuilder(ChatGptUsageStore::class)
            ->onlyMethods(['record', 'latest', 'history', 'earliestSince'])
            ->getMock();
        $chatGptUsageStore->expects($this->once())
            ->method('history')
            ->with(null)
            ->willReturn([
                [
                    'fetched_at' => '2026-01-01T12:00:00Z',
                    'primary_used_percent' => 18,
                ],
            ]);

        $versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['get', 'set'])
            ->getMock();
        $versions->expects($this->once())
            ->method('get')
            ->with('dashboard_graph_stats_backfill_v1')
            ->willReturn(null);
        $versions->expects($this->once())
            ->method('set')
            ->with(
                'dashboard_graph_stats_backfill_v1',
                $this->callback(static fn (?string $value): bool => is_string($value) && $value !== '')
            );

        $service = new DashboardGraphStatsService($repository, $tokenUsages, $chatGptUsageStore, $versions);

        $this->assertSame('2026-01-01T00:00:00Z', $service->firstUsageRecordedAt());
    }
}
