<?php

declare(strict_types=1);

use App\Repositories\IpRateLimitRepository;
use App\Security\RateLimiter;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryIpRateLimitRepository extends IpRateLimitRepository
{
    /** @var array<string, array> */
    public array $store = [];
    public int $pruneCount = 0;

    public function __construct()
    {
    }

    public function find(string $ip, string $bucket): ?array
    {
        $key = $ip . ':' . $bucket;
        return $this->store[$key] ?? null;
    }

    public function upsert(string $ip, string $bucket, int $count, string $resetAt, string $lastHit): void
    {
        $key = $ip . ':' . $bucket;
        $this->store[$key] = [
            'ip' => $ip,
            'bucket' => $bucket,
            'count' => $count,
            'reset_at' => $resetAt,
            'last_hit' => $lastHit,
        ];
    }

    public function pruneExpired(string $now): int
    {
        $this->pruneCount++;
        $removed = 0;
        foreach ($this->store as $key => $row) {
            if (strtotime($row['reset_at']) <= strtotime($now)) {
                unset($this->store[$key]);
                $removed++;
            }
        }
        return $removed;
    }
}

final class RateLimiterTest extends TestCase
{
    private InMemoryIpRateLimitRepository $repository;

    protected function setUp(): void
    {
        $this->repository = new InMemoryIpRateLimitRepository();
    }

    public function testFirstHitIsAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit('1.2.3.4', 'global', 10, 60);

        $this->assertTrue($result['allowed']);
        $this->assertSame(1, $result['count']);
        $this->assertSame(9, $result['remaining']);
        $this->assertSame(10, $result['limit']);
        $this->assertNotNull($result['reset_at']);
    }

    public function testNullIpAlwaysAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit(null, 'global', 10, 60);

        $this->assertTrue($result['allowed']);
        $this->assertSame(0, $result['count']);
    }

    public function testEmptyIpAlwaysAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit('', 'global', 10, 60);

        $this->assertTrue($result['allowed']);
    }

    public function testEmptyBucketAlwaysAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit('1.2.3.4', '', 10, 60);

        $this->assertTrue($result['allowed']);
    }

    public function testZeroLimitAlwaysAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit('1.2.3.4', 'global', 0, 60);

        $this->assertTrue($result['allowed']);
    }

    public function testZeroWindowAlwaysAllowed(): void
    {
        $limiter = new RateLimiter($this->repository);
        $result = $limiter->hit('1.2.3.4', 'global', 10, 0);

        $this->assertTrue($result['allowed']);
    }

    public function testHitsAccumulateAndBlock(): void
    {
        $limiter = new RateLimiter($this->repository);

        // Set up a window that hasn't expired yet
        $resetAt = gmdate(DATE_ATOM, time() + 3600);
        $this->repository->upsert('1.2.3.4', 'global', 9, $resetAt, gmdate(DATE_ATOM));

        $result = $limiter->hit('1.2.3.4', 'global', 10, 60);
        $this->assertTrue($result['allowed']);
        $this->assertSame(10, $result['count']);
        $this->assertSame(0, $result['remaining']);

        // Next hit exceeds limit
        $result = $limiter->hit('1.2.3.4', 'global', 10, 60);
        $this->assertFalse($result['allowed']);
        $this->assertSame(11, $result['count']);
        $this->assertSame(0, $result['remaining']);
    }

    public function testBlockSecondsExtendsResetOnOverLimit(): void
    {
        $limiter = new RateLimiter($this->repository);

        $resetAt = gmdate(DATE_ATOM, time() + 3600);
        $this->repository->upsert('1.2.3.4', 'auth-fail', 10, $resetAt, gmdate(DATE_ATOM));

        $result = $limiter->hit('1.2.3.4', 'auth-fail', 10, 60, 1800);

        $this->assertFalse($result['allowed']);
        // reset_at should be extended by blockSeconds, not original window
        $newReset = strtotime($result['reset_at']);
        $this->assertGreaterThan(time() + 1700, $newReset);
    }

    public function testExpiredWindowResetsCount(): void
    {
        $limiter = new RateLimiter($this->repository);

        // Set up an expired window
        $resetAt = gmdate(DATE_ATOM, time() - 10);
        $this->repository->upsert('1.2.3.4', 'global', 100, $resetAt, gmdate(DATE_ATOM));

        $result = $limiter->hit('1.2.3.4', 'global', 10, 60);
        $this->assertTrue($result['allowed']);
        $this->assertSame(1, $result['count']);
    }

    public function testPruneTriggersAtInterval(): void
    {
        $limiter = new RateLimiter($this->repository, 3);

        $limiter->hit('1.2.3.4', 'global', 100, 3600);
        $limiter->hit('1.2.3.4', 'global', 100, 3600);
        $this->assertSame(0, $this->repository->pruneCount);

        $limiter->hit('1.2.3.4', 'global', 100, 3600);
        $this->assertSame(1, $this->repository->pruneCount);
    }

    public function testDifferentBucketsAreIndependent(): void
    {
        $limiter = new RateLimiter($this->repository);

        $resetAt = gmdate(DATE_ATOM, time() + 3600);
        $this->repository->upsert('1.2.3.4', 'global', 5, $resetAt, gmdate(DATE_ATOM));

        $result = $limiter->hit('1.2.3.4', 'auth-fail', 10, 60);
        $this->assertTrue($result['allowed']);
        $this->assertSame(1, $result['count']);
    }
}
