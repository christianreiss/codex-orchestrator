<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use PDO;

class AdminEventRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function append(string $type, array $payload = [], ?int $hostId = null): array
    {
        $normalizedType = trim($type);
        if ($normalizedType === '') {
            $normalizedType = 'event';
        }

        $createdAt = gmdate(DATE_ATOM);
        $payloadJson = null;
        if ($payload) {
            $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES);
            if ($encoded !== false) {
                $payloadJson = $encoded;
            }
        }
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_events (type, host_id, payload, created_at) VALUES (:type, :host_id, :payload, :created_at)'
        );

        $statement->execute([
            'type' => $normalizedType,
            'host_id' => $hostId,
            'payload' => $payloadJson,
            'created_at' => $createdAt,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return [
            'id' => $id,
            'type' => $normalizedType,
            'host_id' => $hostId,
            'payload' => $payload,
            'created_at' => $createdAt,
        ];
    }

    public function latestId(): int
    {
        $statement = $this->database->connection()->query('SELECT MAX(id) FROM admin_events');
        $value = $statement === false ? null : $statement->fetchColumn();

        return is_numeric($value) ? (int) $value : 0;
    }

    public function sinceId(int $afterId, int $limit = 200): array
    {
        $afterId = max(0, $afterId);
        $limit = max(1, min($limit, 500));

        $statement = $this->database->connection()->prepare(
            'SELECT id, type, host_id, payload, created_at
             FROM admin_events
             WHERE id > :after
             ORDER BY id ASC
             LIMIT :limit'
        );
        $statement->bindValue('after', $afterId, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        if (!is_array($rows)) {
            return [];
        }

        return array_map([$this, 'normalizeRow'], $rows);
    }

    /**
     * Delete admin event entries older than the given number of days.
     *
     * @return int Number of rows deleted.
     */
    public function deleteOlderThan(int $days): int
    {
        if ($days < 1) {
            return 0;
        }

        $cutoff = gmdate(DATE_ATOM, time() - ($days * 86400));
        $statement = $this->database->connection()->prepare(
            'DELETE FROM admin_events WHERE created_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);

        return $statement->rowCount();
    }

    public function recent(int $limit = 50): array
    {
        $limit = max(1, min($limit, 500));
        $statement = $this->database->connection()->prepare(
            'SELECT id, type, host_id, payload, created_at
             FROM admin_events
             ORDER BY id DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        if (!is_array($rows)) {
            return [];
        }

        $normalized = array_map([$this, 'normalizeRow'], $rows);
        return array_reverse($normalized);
    }

    /**
     * @param array<string, mixed> $row
     * @return array{id:int,type:string,host_id:?int,payload:mixed,created_at:?string}
     */
    private function normalizeRow(array $row): array
    {
        $payload = $row['payload'] ?? null;
        if (is_string($payload) && $payload !== '') {
            $decoded = json_decode($payload, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $payload = $decoded;
            }
        }

        return [
            'id' => isset($row['id']) ? (int) $row['id'] : 0,
            'type' => (string) ($row['type'] ?? ''),
            'host_id' => isset($row['host_id']) ? (is_numeric($row['host_id']) ? (int) $row['host_id'] : null) : null,
            'payload' => $payload,
            'created_at' => isset($row['created_at']) ? (string) $row['created_at'] : null,
        ];
    }
}
