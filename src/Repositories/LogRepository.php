<?php

namespace App\Repositories;

use App\Database;
use PDO;

class LogRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO logs (host_id, action, details, created_at) VALUES (:host_id, :action, :details, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details ? json_encode($details, JSON_UNESCAPED_SLASHES) : null,
            'created_at' => gmdate(DATE_ATOM),
        ]);
    }

    public function recent(int $limit = 50, ?int $hostId = null): array
    {
        $limit = max(1, min($limit, 500));
        $connection = $this->database->connection();

        if ($hostId !== null) {
            $statement = $connection->prepare(
                'SELECT id, host_id, action, details, created_at FROM logs WHERE host_id = :host_id ORDER BY created_at DESC, id DESC LIMIT :limit'
            );
            $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        } else {
            $statement = $connection->prepare(
                'SELECT id, host_id, action, details, created_at FROM logs ORDER BY created_at DESC, id DESC LIMIT :limit'
            );
        }

        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function recentByActions(array $actions, int $limit = 20): array
    {
        $actions = array_values(array_filter($actions, static fn ($a) => is_string($a) && $a !== ''));
        if (!$actions) {
            return [];
        }

        $limit = max(1, min($limit, 200));
        $placeholders = implode(',', array_fill(0, count($actions), '?'));

        $statement = $this->database->connection()->prepare(
            "SELECT id, host_id, action, details, created_at
             FROM logs
             WHERE action IN ({$placeholders})
             ORDER BY created_at DESC, id DESC
             LIMIT :limit"
        );

        foreach ($actions as $idx => $action) {
            $statement->bindValue($idx + 1, $action);
        }
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function countActionsSince(array $actions, string $since): int
    {
        $actions = array_values(array_filter($actions, static fn ($a) => is_string($a) && $a !== ''));
        if (!$actions || trim($since) === '') {
            return 0;
        }

        $placeholders = implode(',', array_fill(0, count($actions), '?'));
        $statement = $this->database->connection()->prepare(
            "SELECT COUNT(*) FROM logs WHERE action IN ({$placeholders}) AND created_at >= :since"
        );
        foreach ($actions as $idx => $action) {
            $statement->bindValue($idx + 1, $action);
        }
        $statement->bindValue('since', $since);
        $statement->execute();

        $count = $statement->fetchColumn();

        return is_numeric($count) ? (int) $count : 0;
    }

    public function latestCreatedAt(): ?string
    {
        $statement = $this->database->connection()->query(
            'SELECT created_at FROM logs ORDER BY created_at DESC, id DESC LIMIT 1'
        );

        $value = $statement->fetchColumn();

        return is_string($value) ? $value : null;
    }

    public function tokenUsageTotals(?int $hostId = null): array
    {
        $sql = 'SELECT COALESCE(SUM(total), 0) AS total,
                       COALESCE(SUM(input_tokens), 0) AS input,
                       COALESCE(SUM(output_tokens), 0) AS output,
                       COALESCE(SUM(cached_tokens), 0) AS cached,
                       COUNT(*) AS events
                FROM token_usages';

        $params = [];
        if ($hostId !== null) {
            $sql .= ' WHERE host_id = :host_id';
            $params['host_id'] = $hostId;
        }

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return [
            'total' => isset($row['total']) ? (int) $row['total'] : 0,
            'input' => isset($row['input']) ? (int) $row['input'] : 0,
            'output' => isset($row['output']) ? (int) $row['output'] : 0,
            'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
            'events' => isset($row['events']) ? (int) $row['events'] : 0,
        ];
    }

    public function tokenUsageTotalsByHost(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT host_id,
                    COALESCE(SUM(total), 0) AS total,
                    COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cached_tokens), 0) AS cached,
                    COUNT(*) AS events
             FROM token_usages
             WHERE host_id IS NOT NULL
             GROUP BY host_id'
        );

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $totals = [];
        foreach ($rows as $row) {
            $hostId = isset($row['host_id']) ? (int) $row['host_id'] : null;
            if ($hostId === null) {
                continue;
            }

            $totals[$hostId] = [
                'total' => isset($row['total']) ? (int) $row['total'] : 0,
                'input' => isset($row['input']) ? (int) $row['input'] : 0,
                'output' => isset($row['output']) ? (int) $row['output'] : 0,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
                'events' => isset($row['events']) ? (int) $row['events'] : 0,
            ];
        }

        return $totals;
    }

    public function topTokenUsageHost(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT h.id AS host_id, h.fqdn AS fqdn, COALESCE(SUM(tu.total), 0) AS total
             FROM token_usages tu
             INNER JOIN hosts h ON h.id = tu.host_id
             GROUP BY h.id, h.fqdn
             ORDER BY total DESC
             LIMIT 1'
        );

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return [
            'host_id' => (int) $row['host_id'],
            'fqdn' => $row['fqdn'],
            'total' => isset($row['total']) ? (int) $row['total'] : 0,
        ];
    }
}
