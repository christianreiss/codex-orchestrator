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
        $sql = <<<SQL
            SELECT
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.total')) AS UNSIGNED)), 0) AS total,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.input')) AS UNSIGNED)), 0) AS input,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.output')) AS UNSIGNED)), 0) AS output,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.cached')) AS UNSIGNED)), 0) AS cached,
                COUNT(*) AS events
            FROM logs
            WHERE action = 'token.usage'
        SQL;

        $params = [];
        if ($hostId !== null) {
            $sql .= ' AND host_id = :host_id';
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
        $sql = <<<SQL
            SELECT
                host_id,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.total')) AS UNSIGNED)), 0) AS total,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.input')) AS UNSIGNED)), 0) AS input,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.output')) AS UNSIGNED)), 0) AS output,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(details, '$.cached')) AS UNSIGNED)), 0) AS cached,
                COUNT(*) AS events
            FROM logs
            WHERE action = 'token.usage' AND host_id IS NOT NULL
            GROUP BY host_id
        SQL;

        $statement = $this->database->connection()->query($sql);
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
        $sql = <<<SQL
            SELECT
                h.id AS host_id,
                h.fqdn AS fqdn,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(l.details, '$.total')) AS UNSIGNED)), 0) AS total
            FROM logs l
            INNER JOIN hosts h ON h.id = l.host_id
            WHERE l.action = 'token.usage'
            GROUP BY h.id, h.fqdn
            ORDER BY total DESC
            LIMIT 1
        SQL;

        $statement = $this->database->connection()->query($sql);
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
