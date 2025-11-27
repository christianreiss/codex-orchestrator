<?php

namespace App\Repositories;

use App\Database;
use PDO;

class IpRateLimitRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function find(string $ip, string $bucket): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM ip_rate_limits WHERE ip = :ip AND bucket = :bucket LIMIT 1'
        );
        $statement->execute([
            'ip' => $ip,
            'bucket' => $bucket,
        ]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ?: null;
    }

    public function upsert(string $ip, string $bucket, int $count, string $resetAt, string $lastHit): void
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            <<<SQL
            INSERT INTO ip_rate_limits (ip, bucket, count, reset_at, last_hit, created_at)
            VALUES (:ip, :bucket, :count, :reset_at, :last_hit, :created_at)
            ON DUPLICATE KEY UPDATE
                count = :count_u,
                reset_at = :reset_at_u,
                last_hit = :last_hit_u
            SQL
        );

        $statement->execute([
            'ip' => $ip,
            'bucket' => $bucket,
            'count' => $count,
            'reset_at' => $resetAt,
            'last_hit' => $lastHit,
            'created_at' => $now,
            'count_u' => $count,
            'reset_at_u' => $resetAt,
            'last_hit_u' => $lastHit,
        ]);
    }

    public function pruneExpired(string $now): int
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM ip_rate_limits WHERE reset_at <= :now'
        );
        $statement->execute(['now' => $now]);

        return (int) $statement->rowCount();
    }
}
