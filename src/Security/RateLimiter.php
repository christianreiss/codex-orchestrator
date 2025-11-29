<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Security;

use App\Repositories\IpRateLimitRepository;

class RateLimiter
{
    private int $hitCount = 0;

    public function __construct(
        private readonly IpRateLimitRepository $limits,
        private readonly int $pruneInterval = 200
    ) {
    }

    /**
     * Register a hit for the provided IP/bucket and return the remaining allowance.
     *
     * @return array{allowed: bool, count: int, remaining: int, reset_at: ?string, limit: int}
     */
    public function hit(?string $ip, string $bucket, int $limit, int $windowSeconds, ?int $blockSeconds = null): array
    {
        if ($ip === null || $ip === '' || $bucket === '' || $limit <= 0 || $windowSeconds <= 0) {
            return [
                'allowed' => true,
                'count' => 0,
                'remaining' => $limit,
                'reset_at' => null,
                'limit' => $limit,
            ];
        }

        $now = time();
        $nowAtom = gmdate(DATE_ATOM, $now);
        $this->maybePrune($nowAtom);

        $row = $this->limits->find($ip, $bucket);
        $resetAt = $row['reset_at'] ?? null;
        $resetTs = $resetAt ? strtotime((string) $resetAt) : null;

        if ($row === null || $resetTs === false || $resetTs <= $now) {
            $resetAt = gmdate(DATE_ATOM, $now + $windowSeconds);
            $this->limits->upsert($ip, $bucket, 1, $resetAt, $nowAtom);

            return [
                'allowed' => true,
                'count' => 1,
                'remaining' => max(0, $limit - 1),
                'reset_at' => $resetAt,
                'limit' => $limit,
            ];
        }

        $count = (int) ($row['count'] ?? 0);
        $count++;
        $blocked = $count > $limit;

        if ($blocked && $blockSeconds !== null && $blockSeconds > 0) {
            $resetAt = gmdate(DATE_ATOM, $now + $blockSeconds);
        }

        $this->limits->upsert($ip, $bucket, $count, $resetAt, $nowAtom);

        return [
            'allowed' => !$blocked,
            'count' => $count,
            'remaining' => max(0, $limit - $count),
            'reset_at' => $resetAt,
            'limit' => $limit,
        ];
    }

    private function maybePrune(string $now): void
    {
        if ($this->pruneInterval <= 0) {
            return;
        }

        $this->hitCount++;
        if (($this->hitCount % $this->pruneInterval) === 0) {
            $this->limits->pruneExpired($now);
        }
    }
}
