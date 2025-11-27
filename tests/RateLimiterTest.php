<?php

declare(strict_types=1);

use App\Repositories\IpRateLimitRepository;
use App\Security\RateLimiter;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

class InMemoryIpRateLimitRepository extends IpRateLimitRepository
{
    public array $store = [];

    public function __construct()
    {
    }

    public function find(string $ip, string $bucket): ?array
    {
        return $this->store[$ip][$bucket] ?? null;
    }

    public function upsert(string $ip, string $bucket, int $count, string $resetAt, string $lastHit): void
    {
        $existing = $this->store[$ip][$bucket] ?? [];
        $this->store[$ip][$bucket] = array_merge($existing, [
            'ip' => $ip,
            'bucket' => $bucket,
            'count' => $count,
            'reset_at' => $resetAt,
            'last_hit' => $lastHit,
            'created_at' => $existing['created_at'] ?? $lastHit,
        ]);
    }

    public function pruneExpired(string $now): int
    {
        $before = count($this->store, COUNT_RECURSIVE);
        foreach ($this->store as $ip => $buckets) {
            foreach ($buckets as $bucket => $row) {
                $resetAt = $row['reset_at'] ?? '';
                $expired = $resetAt !== '' && strtotime($resetAt) <= strtotime($now);
                if ($expired) {
                    unset($this->store[$ip][$bucket]);
                }
            }
            if (empty($this->store[$ip])) {
                unset($this->store[$ip]);
            }
        }
        $after = count($this->store, COUNT_RECURSIVE);

        return max(0, $before - $after);
    }
}

final class RateLimiterTest extends TestCase
{
    public function testBlocksAfterLimitAndResetsAfterWindow(): void
    {
        $repo = new InMemoryIpRateLimitRepository();
        $limiter = new RateLimiter($repo, pruneInterval: 0);

        $hit1 = $limiter->hit('1.1.1.1', 'global', 3, 60);
        $hit2 = $limiter->hit('1.1.1.1', 'global', 3, 60);
        $hit3 = $limiter->hit('1.1.1.1', 'global', 3, 60);
        $hit4 = $limiter->hit('1.1.1.1', 'global', 3, 60);

        $this->assertTrue($hit1['allowed']);
        $this->assertTrue($hit2['allowed']);
        $this->assertTrue($hit3['allowed']);
        $this->assertFalse($hit4['allowed']);
        $this->assertSame(4, $hit4['count']);

        // Force the window to expire and ensure the counter resets.
        $repo->store['1.1.1.1']['global']['reset_at'] = gmdate(DATE_ATOM, time() - 10);
        $hit5 = $limiter->hit('1.1.1.1', 'global', 3, 60);

        $this->assertTrue($hit5['allowed']);
        $this->assertSame(1, $hit5['count']);
    }
}
