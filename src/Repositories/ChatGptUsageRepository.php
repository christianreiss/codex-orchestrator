<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Repositories;

use App\Database;
use PDO;

class ChatGptUsageRepository implements ChatGptUsageStore
{
    public function __construct(private readonly Database $database)
    {
    }

    public function record(array $snapshot): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO chatgpt_usage_snapshots (
                host_id,
                status,
                plan_type,
                rate_allowed,
                rate_limit_reached,
                primary_used_percent,
                primary_limit_seconds,
                primary_reset_after_seconds,
                primary_reset_at,
                secondary_used_percent,
                secondary_limit_seconds,
                secondary_reset_after_seconds,
                secondary_reset_at,
                has_credits,
                unlimited,
                credit_balance,
                approx_local_messages,
                approx_cloud_messages,
                raw,
                error,
                fetched_at,
                next_eligible_at,
                created_at
            ) VALUES (
                :host_id,
                :status,
                :plan_type,
                :rate_allowed,
                :rate_limit_reached,
                :primary_used_percent,
                :primary_limit_seconds,
                :primary_reset_after_seconds,
                :primary_reset_at,
                :secondary_used_percent,
                :secondary_limit_seconds,
                :secondary_reset_after_seconds,
                :secondary_reset_at,
                :has_credits,
                :unlimited,
                :credit_balance,
                :approx_local_messages,
                :approx_cloud_messages,
                :raw,
                :error,
                :fetched_at,
                :next_eligible_at,
                :created_at
            )'
        );

        $now = gmdate(DATE_ATOM);
        $statement->execute([
            'host_id' => $snapshot['host_id'] ?? null,
            'status' => $snapshot['status'] ?? 'ok',
            'plan_type' => $snapshot['plan_type'] ?? null,
            'rate_allowed' => isset($snapshot['rate_allowed']) ? ($snapshot['rate_allowed'] ? 1 : 0) : null,
            'rate_limit_reached' => isset($snapshot['rate_limit_reached']) ? ($snapshot['rate_limit_reached'] ? 1 : 0) : null,
            'primary_used_percent' => $snapshot['primary_used_percent'] ?? null,
            'primary_limit_seconds' => $snapshot['primary_limit_seconds'] ?? null,
            'primary_reset_after_seconds' => $snapshot['primary_reset_after_seconds'] ?? null,
            'primary_reset_at' => $snapshot['primary_reset_at'] ?? null,
            'secondary_used_percent' => $snapshot['secondary_used_percent'] ?? null,
            'secondary_limit_seconds' => $snapshot['secondary_limit_seconds'] ?? null,
            'secondary_reset_after_seconds' => $snapshot['secondary_reset_after_seconds'] ?? null,
            'secondary_reset_at' => $snapshot['secondary_reset_at'] ?? null,
            'has_credits' => isset($snapshot['has_credits']) ? ($snapshot['has_credits'] ? 1 : 0) : null,
            'unlimited' => isset($snapshot['unlimited']) ? ($snapshot['unlimited'] ? 1 : 0) : null,
            'credit_balance' => $snapshot['credit_balance'] ?? null,
            'approx_local_messages' => $this->encodeArrayField($snapshot['approx_local_messages'] ?? null),
            'approx_cloud_messages' => $this->encodeArrayField($snapshot['approx_cloud_messages'] ?? null),
            'raw' => $snapshot['raw'] ?? null,
            'error' => $snapshot['error'] ?? null,
            'fetched_at' => $snapshot['fetched_at'] ?? $now,
            'next_eligible_at' => $snapshot['next_eligible_at'] ?? $now,
            'created_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return $this->findById($id);
    }

    public function latest(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT * FROM chatgpt_usage_snapshots ORDER BY fetched_at DESC, id DESC LIMIT 1'
        );
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ? $this->normalizeRow($row) : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM chatgpt_usage_snapshots WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ? $this->normalizeRow($row) : null;
    }

    public function history(?string $since = null): array
    {
        $params = [];
        $sql = 'SELECT fetched_at, primary_used_percent, secondary_used_percent, primary_limit_seconds, secondary_limit_seconds FROM chatgpt_usage_snapshots';
        if ($since !== null) {
            $sql .= ' WHERE fetched_at >= :since';
            $params['since'] = $since;
        }
        $sql .= ' ORDER BY fetched_at ASC';

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_map(static function (array $row): array {
            foreach (['primary_used_percent', 'secondary_used_percent', 'primary_limit_seconds', 'secondary_limit_seconds'] as $key) {
                if (array_key_exists($key, $row) && $row[$key] !== null) {
                    $row[$key] = (int) $row[$key];
                }
            }
            return $row;
        }, $rows ?: []);
    }

    private function encodeArrayField(mixed $value): ?string
    {
        if (is_array($value)) {
            return json_encode($value, JSON_UNESCAPED_SLASHES);
        }

        if (is_string($value)) {
            return $value;
        }

        return null;
    }

    private function decodeArrayField(?string $value): mixed
    {
        if ($value === null || $value === '') {
            return null;
        }

        $decoded = json_decode($value, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            return $decoded;
        }

        return $value;
    }

    private function normalizeRow(array $row): array
    {
        $row['id'] = isset($row['id']) ? (int) $row['id'] : null;
        foreach (['primary_used_percent', 'primary_limit_seconds', 'primary_reset_after_seconds', 'secondary_used_percent', 'secondary_limit_seconds', 'secondary_reset_after_seconds'] as $key) {
            if (isset($row[$key]) && $row[$key] !== null) {
                $row[$key] = (int) $row[$key];
            }
        }
        foreach (['rate_allowed', 'rate_limit_reached', 'has_credits', 'unlimited'] as $key) {
            if (array_key_exists($key, $row) && $row[$key] !== null) {
                $row[$key] = (bool) (int) $row[$key];
            }
        }
        $row['approx_local_messages'] = $this->decodeArrayField($row['approx_local_messages'] ?? null);
        $row['approx_cloud_messages'] = $this->decodeArrayField($row['approx_cloud_messages'] ?? null);

        return $row;
    }
}
