<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class DashboardGraphStatsRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function incrementUsageDaily(array $usage, ?string $recordedAt = null): void
    {
        $timestamp = $this->normalizeTimestamp($recordedAt);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO dashboard_graph_usage_daily_stats (
                stat_date,
                total_tokens,
                input_tokens,
                output_tokens,
                cached_tokens,
                reasoning_tokens,
                cost,
                created_at,
                updated_at
            ) VALUES (
                :stat_date,
                :total_tokens,
                :input_tokens,
                :output_tokens,
                :cached_tokens,
                :reasoning_tokens,
                :cost,
                :created_at,
                :updated_at
            )
            ON DUPLICATE KEY UPDATE
                total_tokens = COALESCE(total_tokens, 0) + VALUES(total_tokens),
                input_tokens = COALESCE(input_tokens, 0) + VALUES(input_tokens),
                output_tokens = COALESCE(output_tokens, 0) + VALUES(output_tokens),
                cached_tokens = COALESCE(cached_tokens, 0) + VALUES(cached_tokens),
                reasoning_tokens = COALESCE(reasoning_tokens, 0) + VALUES(reasoning_tokens),
                cost = CASE
                    WHEN cost IS NULL AND VALUES(cost) IS NULL THEN NULL
                    ELSE COALESCE(cost, 0) + COALESCE(VALUES(cost), 0)
                END,
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'stat_date' => substr($timestamp, 0, 10),
            'total_tokens' => max(0, (int) ($usage['total'] ?? 0)),
            'input_tokens' => max(0, (int) ($usage['input'] ?? 0)),
            'output_tokens' => max(0, (int) ($usage['output'] ?? 0)),
            'cached_tokens' => max(0, (int) ($usage['cached'] ?? 0)),
            'reasoning_tokens' => max(0, (int) ($usage['reasoning'] ?? 0)),
            'cost' => isset($usage['cost']) ? (float) $usage['cost'] : null,
            'created_at' => $timestamp,
            'updated_at' => $timestamp,
        ]);
    }

    public function upsertUsageDaily(array $usage): void
    {
        $day = trim((string) ($usage['date'] ?? ''));
        if ($day === '') {
            return;
        }

        $timestamp = $this->normalizeTimestamp(($usage['updated_at'] ?? null));
        $statement = $this->database->connection()->prepare(
            'INSERT INTO dashboard_graph_usage_daily_stats (
                stat_date,
                total_tokens,
                input_tokens,
                output_tokens,
                cached_tokens,
                reasoning_tokens,
                cost,
                created_at,
                updated_at
            ) VALUES (
                :stat_date,
                :total_tokens,
                :input_tokens,
                :output_tokens,
                :cached_tokens,
                :reasoning_tokens,
                :cost,
                :created_at,
                :updated_at
            )
            ON DUPLICATE KEY UPDATE
                total_tokens = VALUES(total_tokens),
                input_tokens = VALUES(input_tokens),
                output_tokens = VALUES(output_tokens),
                cached_tokens = VALUES(cached_tokens),
                reasoning_tokens = VALUES(reasoning_tokens),
                cost = VALUES(cost),
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'stat_date' => $day,
            'total_tokens' => max(0, (int) ($usage['total'] ?? 0)),
            'input_tokens' => max(0, (int) ($usage['input'] ?? 0)),
            'output_tokens' => max(0, (int) ($usage['output'] ?? 0)),
            'cached_tokens' => max(0, (int) ($usage['cached'] ?? 0)),
            'reasoning_tokens' => max(0, (int) ($usage['reasoning'] ?? 0)),
            'cost' => isset($usage['cost']) ? (float) $usage['cost'] : null,
            'created_at' => $timestamp,
            'updated_at' => $timestamp,
        ]);
    }

    public function firstUsageRecordedAt(): ?string
    {
        $statement = $this->database->connection()->query(
            'SELECT stat_date FROM dashboard_graph_usage_daily_stats ORDER BY stat_date ASC LIMIT 1'
        );
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: null;
        $day = isset($row['stat_date']) ? trim((string) $row['stat_date']) : '';

        return $day !== '' ? $day . 'T00:00:00Z' : null;
    }

    public function usageDailySince(string $startIso): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT stat_date AS day,
                    input_tokens AS input,
                    output_tokens AS output,
                    cached_tokens AS cached,
                    reasoning_tokens AS reasoning,
                    total_tokens AS total,
                    cost
             FROM dashboard_graph_usage_daily_stats
             WHERE stat_date >= :start_date
             ORDER BY stat_date ASC'
        );
        $statement->execute([
            'start_date' => substr($this->normalizeTimestamp($startIso), 0, 10),
        ]);

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        return array_map(static function (array $row): array {
            return [
                'date' => (string) ($row['day'] ?? ''),
                'input' => isset($row['input']) ? (int) $row['input'] : 0,
                'output' => isset($row['output']) ? (int) $row['output'] : 0,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : 0,
                'total' => isset($row['total']) ? (int) $row['total'] : 0,
                'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
            ];
        }, $rows);
    }

    public function recordQuotaSnapshot(array $snapshot): void
    {
        $fetchedAt = $this->normalizeTimestamp($snapshot['fetched_at'] ?? null);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO dashboard_graph_quota_snapshots (
                fetched_at,
                primary_used_percent,
                primary_limit_seconds,
                secondary_used_percent,
                secondary_limit_seconds,
                spark_primary_used_percent,
                spark_primary_limit_seconds,
                spark_secondary_used_percent,
                spark_secondary_limit_seconds,
                created_at,
                updated_at
            ) VALUES (
                :fetched_at,
                :primary_used_percent,
                :primary_limit_seconds,
                :secondary_used_percent,
                :secondary_limit_seconds,
                :spark_primary_used_percent,
                :spark_primary_limit_seconds,
                :spark_secondary_used_percent,
                :spark_secondary_limit_seconds,
                :created_at,
                :updated_at
            )
            ON DUPLICATE KEY UPDATE
                primary_used_percent = VALUES(primary_used_percent),
                primary_limit_seconds = VALUES(primary_limit_seconds),
                secondary_used_percent = VALUES(secondary_used_percent),
                secondary_limit_seconds = VALUES(secondary_limit_seconds),
                spark_primary_used_percent = VALUES(spark_primary_used_percent),
                spark_primary_limit_seconds = VALUES(spark_primary_limit_seconds),
                spark_secondary_used_percent = VALUES(spark_secondary_used_percent),
                spark_secondary_limit_seconds = VALUES(spark_secondary_limit_seconds),
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'fetched_at' => $fetchedAt,
            'primary_used_percent' => $this->nullableInt($snapshot['primary_used_percent'] ?? null),
            'primary_limit_seconds' => $this->nullableInt($snapshot['primary_limit_seconds'] ?? null),
            'secondary_used_percent' => $this->nullableInt($snapshot['secondary_used_percent'] ?? null),
            'secondary_limit_seconds' => $this->nullableInt($snapshot['secondary_limit_seconds'] ?? null),
            'spark_primary_used_percent' => $this->nullableInt($snapshot['spark_primary_used_percent'] ?? null),
            'spark_primary_limit_seconds' => $this->nullableInt($snapshot['spark_primary_limit_seconds'] ?? null),
            'spark_secondary_used_percent' => $this->nullableInt($snapshot['spark_secondary_used_percent'] ?? null),
            'spark_secondary_limit_seconds' => $this->nullableInt($snapshot['spark_secondary_limit_seconds'] ?? null),
            'created_at' => $fetchedAt,
            'updated_at' => $fetchedAt,
        ]);
    }

    public function quotaHistory(?string $since = null): array
    {
        $params = [];
        $sql = 'SELECT fetched_at,
                    primary_used_percent,
                    secondary_used_percent,
                    primary_limit_seconds,
                    secondary_limit_seconds,
                    spark_primary_used_percent,
                    spark_secondary_used_percent,
                    spark_primary_limit_seconds,
                    spark_secondary_limit_seconds
                FROM dashboard_graph_quota_snapshots';
        if ($since !== null) {
            $sql .= ' WHERE fetched_at >= :since';
            $params['since'] = $this->normalizeTimestamp($since);
        }
        $sql .= ' ORDER BY fetched_at ASC';

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        return array_map(static function (array $row): array {
            foreach ([
                'primary_used_percent',
                'secondary_used_percent',
                'primary_limit_seconds',
                'secondary_limit_seconds',
                'spark_primary_used_percent',
                'spark_secondary_used_percent',
                'spark_primary_limit_seconds',
                'spark_secondary_limit_seconds',
            ] as $key) {
                if (array_key_exists($key, $row) && $row[$key] !== null) {
                    $row[$key] = (int) $row[$key];
                }
            }
            return $row;
        }, $rows);
    }

    public function deleteOlderThan(int $days): array
    {
        if ($days < 1) {
            return ['usage' => 0, 'quota' => 0];
        }

        $usageCutoff = gmdate('Y-m-d', time() - ($days * 86400));
        $quotaCutoff = gmdate(DATE_ATOM, time() - ($days * 86400));

        $usageStatement = $this->database->connection()->prepare(
            'DELETE FROM dashboard_graph_usage_daily_stats WHERE stat_date < :cutoff'
        );
        $usageStatement->execute(['cutoff' => $usageCutoff]);

        $quotaStatement = $this->database->connection()->prepare(
            'DELETE FROM dashboard_graph_quota_snapshots WHERE fetched_at < :cutoff'
        );
        $quotaStatement->execute(['cutoff' => $quotaCutoff]);

        return [
            'usage' => $usageStatement->rowCount(),
            'quota' => $quotaStatement->rowCount(),
        ];
    }

    private function normalizeTimestamp(?string $value): string
    {
        $trimmed = is_string($value) ? trim($value) : '';
        if ($trimmed === '') {
            return gmdate(DATE_ATOM);
        }
        return $trimmed;
    }

    private function nullableInt(mixed $value): ?int
    {
        return is_numeric($value) ? (int) $value : null;
    }
}
