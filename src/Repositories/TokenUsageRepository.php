<?php

namespace App\Repositories;

use App\Database;
use PDO;

class TokenUsageRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function record(?int $hostId, ?int $total, ?int $input, ?int $output, ?int $cached, ?string $model, ?string $line): void
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO token_usages (host_id, total, input_tokens, output_tokens, cached_tokens, model, line, created_at)
             VALUES (:host_id, :total, :input_tokens, :output_tokens, :cached_tokens, :model, :line, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'total' => $total,
            'input_tokens' => $input,
            'output_tokens' => $output,
            'cached_tokens' => $cached,
            'model' => $model,
            'line' => $line,
            'created_at' => gmdate(DATE_ATOM),
        ]);
    }

    public function totals(?int $hostId = null): array
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
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];

        return [
            'total' => isset($row['total']) ? (int) $row['total'] : 0,
            'input' => isset($row['input']) ? (int) $row['input'] : 0,
            'output' => isset($row['output']) ? (int) $row['output'] : 0,
            'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
            'events' => isset($row['events']) ? (int) $row['events'] : 0,
        ];
    }

    public function totalsByHost(): array
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

    public function topHost(): ?array
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
