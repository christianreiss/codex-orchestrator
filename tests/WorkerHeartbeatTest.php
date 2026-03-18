<?php

declare(strict_types=1);

use App\Support\WorkerHeartbeat;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class WorkerHeartbeatTest extends TestCase
{
    public function testFreshSuccessIsHealthy(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'heartbeat');
        self::assertIsString($path);

        $now = 1_700_000_000;
        $heartbeat = new WorkerHeartbeat($path, static fn (): int => $now);
        $heartbeat->recordAttempt();
        $heartbeat->recordSuccess(['summary' => 'ok']);

        $result = $heartbeat->evaluateHealth(300, 120);

        self::assertTrue($result['healthy']);
        self::assertSame('fresh_success', $result['reason']);
        self::assertSame('ok', $result['data']['summary'] ?? null);

        @unlink($path);
    }

    public function testFailureWithoutSuccessExpiresAfterStartupGrace(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'heartbeat');
        self::assertIsString($path);

        $clock = 1_700_000_000;
        $heartbeat = new WorkerHeartbeat($path, static function () use (&$clock): int {
            return $clock;
        });

        $heartbeat->recordAttempt();
        $heartbeat->recordFailure('network down');

        $initial = $heartbeat->evaluateHealth(300, 120);
        self::assertTrue($initial['healthy']);
        self::assertSame('startup_grace', $initial['reason']);

        $clock += 121;
        $expired = $heartbeat->evaluateHealth(300, 120);
        self::assertFalse($expired['healthy']);
        self::assertSame('no_success_yet', $expired['reason']);

        @unlink($path);
    }

    public function testStaleSuccessBecomesUnhealthy(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'heartbeat');
        self::assertIsString($path);

        $clock = 1_700_000_000;
        $heartbeat = new WorkerHeartbeat($path, static function () use (&$clock): int {
            return $clock;
        });

        $heartbeat->recordAttempt();
        $heartbeat->recordSuccess();

        $clock += 301;
        $result = $heartbeat->evaluateHealth(300, 120);

        self::assertFalse($result['healthy']);
        self::assertSame('stale_success', $result['reason']);

        @unlink($path);
    }
}
