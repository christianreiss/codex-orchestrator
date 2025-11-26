<?php

declare(strict_types=1);

use App\Repositories\ChatGptUsageStore;
use App\Repositories\LogRepository;
use App\Services\ChatGptUsageService;
use App\Services\AuthService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

class InMemoryChatGptUsageRepository implements ChatGptUsageStore
{
    public array $items = [];

    public function record(array $snapshot): array
    {
        $snapshot['id'] = count($this->items) + 1;
        $this->items[] = $snapshot;

        return $snapshot;
    }

    public function latest(): ?array
    {
        return $this->items ? $this->items[array_key_last($this->items)] : null;
    }
}

final class ChatGptUsageServiceTest extends TestCase
{
    public function testReturnsCachedSnapshotWithinCooldown(): void
    {
        $repo = new InMemoryChatGptUsageRepository();
        $repo->items[] = [
            'id' => 1,
            'status' => 'ok',
            'plan_type' => 'pro',
            'fetched_at' => gmdate(DATE_ATOM, time() - 60),
            'next_eligible_at' => gmdate(DATE_ATOM, time() + 200),
        ];
        $auth = $this->getMockBuilder(AuthService::class)->disableOriginalConstructor()->onlyMethods(['canonicalAuthSnapshot'])->getMock();
        $auth->method('canonicalAuthSnapshot')->willReturn(['tokens' => ['access_token' => 'x']]);
        $logs = $this->getMockBuilder(LogRepository::class)->disableOriginalConstructor()->onlyMethods(['log'])->getMock();
        $called = 0;
        $service = new ChatGptUsageService(
            $auth,
            $repo,
            $logs,
            'https://chatgpt.com/backend-api',
            5.0,
            function () use (&$called) {
                $called++;
                return ['status' => 200, 'body' => '{}', 'json' => [], 'error' => null];
            }
        );

        $result = $service->fetchLatest(false);

        $this->assertTrue($result['cached']);
        $this->assertSame(1, $repo->items[0]['id']);
        $this->assertSame(0, $called);
    }

    public function testErrorsWhenTokenMissing(): void
    {
        $repo = new InMemoryChatGptUsageRepository();
        $auth = $this->getMockBuilder(AuthService::class)->disableOriginalConstructor()->onlyMethods(['canonicalAuthSnapshot'])->getMock();
        $auth->method('canonicalAuthSnapshot')->willReturn(['tokens' => ['access_token' => '']]);
        $logs = $this->getMockBuilder(LogRepository::class)->disableOriginalConstructor()->onlyMethods(['log'])->getMock();
        $service = new ChatGptUsageService(
            $auth,
            $repo,
            $logs,
            'https://chatgpt.com/backend-api',
            5.0,
            function () {
                $this->fail('HTTP client should not be called without token');
            }
        );

        $result = $service->fetchLatest(true);

        $this->assertFalse($result['cached']);
        $this->assertSame('error', $result['snapshot']['status']);
        $this->assertStringContainsString('access_token', $result['snapshot']['error']);
        $this->assertCount(1, $repo->items);
    }

    public function testParsesSuccessfulResponse(): void
    {
        $repo = new InMemoryChatGptUsageRepository();
        $auth = $this->getMockBuilder(AuthService::class)->disableOriginalConstructor()->onlyMethods(['canonicalAuthSnapshot'])->getMock();
        $auth->method('canonicalAuthSnapshot')->willReturn(['tokens' => ['access_token' => 'abc', 'account_id' => 'acct_123']]);
        $logs = $this->getMockBuilder(LogRepository::class)->disableOriginalConstructor()->onlyMethods(['log'])->getMock();
        $payload = [
            'plan_type' => 'pro',
            'rate_limit' => [
                'allowed' => true,
                'limit_reached' => false,
                'primary_window' => [
                    'used_percent' => 10,
                    'limit_window_seconds' => 18000,
                    'reset_after_seconds' => 300,
                    'reset_at' => 1234567890,
                ],
                'secondary_window' => [
                    'used_percent' => 20,
                    'limit_window_seconds' => 604800,
                    'reset_after_seconds' => 999,
                    'reset_at' => 1234567999,
                ],
            ],
            'credits' => [
                'has_credits' => false,
                'unlimited' => false,
                'balance' => '0',
                'approx_local_messages' => [0, 0],
                'approx_cloud_messages' => [0, 0],
            ],
        ];
        $service = new ChatGptUsageService(
            $auth,
            $repo,
            $logs,
            'https://chatgpt.com/backend-api',
            5.0,
            function () use ($payload) {
                return [
                    'status' => 200,
                    'body' => json_encode($payload),
                    'json' => $payload,
                    'error' => null,
                ];
            }
        );

        $result = $service->fetchLatest(true);
        $snapshot = $result['snapshot'];

        $this->assertSame('pro', $snapshot['plan_type']);
        $this->assertSame(10, $snapshot['primary_used_percent']);
        $this->assertSame(20, $snapshot['secondary_used_percent']);
        $this->assertSame([0, 0], $snapshot['approx_local_messages']);
        $this->assertFalse($result['cached']);
    }

    public function testLatestWindowSummaryReturnsPrimaryAndSecondaryWindows(): void
    {
        $repo = new InMemoryChatGptUsageRepository();
        $repo->record([
            'status' => 'ok',
            'plan_type' => 'team',
            'rate_allowed' => true,
            'rate_limit_reached' => false,
            'primary_used_percent' => 45,
            'primary_limit_seconds' => 18000,
            'primary_reset_after_seconds' => 600,
            'primary_reset_at' => '2025-11-26T15:00:00Z',
            'secondary_used_percent' => 12,
            'secondary_limit_seconds' => 604800,
            'secondary_reset_after_seconds' => 7200,
            'secondary_reset_at' => '2025-12-02T00:00:00Z',
            'fetched_at' => '2025-11-26T10:00:00Z',
            'next_eligible_at' => '2025-11-26T10:05:00Z',
        ]);

        $auth = $this->getMockBuilder(AuthService::class)->disableOriginalConstructor()->getMock();
        $logs = $this->getMockBuilder(LogRepository::class)->disableOriginalConstructor()->getMock();
        $service = new ChatGptUsageService($auth, $repo, $logs);

        $summary = $service->latestWindowSummary();

        $this->assertNotNull($summary);
        $this->assertSame('team', $summary['plan_type']);
        $this->assertSame(45, $summary['primary_window']['used_percent']);
        $this->assertSame(604800, $summary['secondary_window']['limit_seconds']);
        $this->assertSame('2025-12-02T00:00:00Z', $summary['secondary_window']['reset_at']);
    }
}
