<?php

namespace App\Repositories;

use App\Database;
use PDO;

class TokenUsageRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function record(
        ?int $hostId,
        ?int $total,
        ?int $input,
        ?int $output,
        ?int $cached,
        ?int $reasoning,
        ?string $model,
        ?string $line
    ): void {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO token_usages (host_id, total, input_tokens, output_tokens, cached_tokens, reasoning_tokens, model, line, created_at)
             VALUES (:host_id, :total, :input_tokens, :output_tokens, :cached_tokens, :reasoning_tokens, :model, :line, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'total' => $total,
            'input_tokens' => $input,
            'output_tokens' => $output,
            'cached_tokens' => $cached,
            'reasoning_tokens' => $reasoning,
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
                       COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
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
            'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : 0,
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
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
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
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : 0,
                'events' => isset($row['events']) ? (int) $row['events'] : 0,
            ];
        }

        return $totals;
    }

    public function totalsForRange(string $startIso, string $endIso): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT COALESCE(SUM(total), 0) AS total,
                    COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cached_tokens), 0) AS cached,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
                    COUNT(*) AS events
             FROM token_usages
             WHERE created_at >= :start AND created_at < :end'
        );
        $statement->execute([
            'start' => $startIso,
            'end' => $endIso,
        ]);
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];

        return [
            'total' => isset($row['total']) ? (int) $row['total'] : 0,
            'input' => isset($row['input']) ? (int) $row['input'] : 0,
            'output' => isset($row['output']) ? (int) $row['output'] : 0,
            'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
            'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : 0,
            'events' => isset($row['events']) ? (int) $row['events'] : 0,
        ];
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

    public function latestForHost(int $hostId): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT total, input_tokens AS input, output_tokens AS output, cached_tokens AS cached, reasoning_tokens AS reasoning, model, line, created_at
             FROM token_usages
             WHERE host_id = :host_id
             ORDER BY created_at DESC, id DESC
             LIMIT 1'
        );
        $statement->execute(['host_id' => $hostId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return [
            'total' => isset($row['total']) ? (int) $row['total'] : null,
            'input' => isset($row['input']) ? (int) $row['input'] : null,
            'output' => isset($row['output']) ? (int) $row['output'] : null,
            'cached' => isset($row['cached']) ? (int) $row['cached'] : null,
            'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : null,
            'model' => $row['model'] ?? null,
            'line' => $row['line'] ?? null,
            'created_at' => $row['created_at'] ?? null,
        ];
    }

    public function recent(int $limit = 50): array
    {
        $limit = max(1, min($limit, 500));
        $statement = $this->database->connection()->prepare(
            'SELECT tu.id,
                    tu.host_id,
                    h.fqdn AS fqdn,
                    tu.total,
                    tu.input_tokens AS input,
                    tu.output_tokens AS output,
                    tu.cached_tokens AS cached,
                    tu.reasoning_tokens AS reasoning,
                    tu.model,
                    tu.line,
                    tu.created_at
             FROM token_usages tu
             LEFT JOIN hosts h ON h.id = tu.host_id
             ORDER BY tu.created_at DESC, tu.id DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $items = [];
        foreach ($rows as $row) {
            $items[] = [
                'id' => isset($row['id']) ? (int) $row['id'] : null,
                'host_id' => isset($row['host_id']) ? (int) $row['host_id'] : null,
                'fqdn' => $row['fqdn'] ?? null,
                'total' => isset($row['total']) ? (int) $row['total'] : null,
                'input' => isset($row['input']) ? (int) $row['input'] : null,
                'output' => isset($row['output']) ? (int) $row['output'] : null,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : null,
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : null,
                'model' => $row['model'] ?? null,
                'line' => $row['line'] ?? null,
                'created_at' => $row['created_at'] ?? null,
            ];
        }

        return $items;
    }

    public function topTokens(int $limit = 50): array
    {
        $limit = max(1, min($limit, 200));
        $statement = $this->database->connection()->prepare(
            'SELECT line,
                    COUNT(*) AS events,
                    COALESCE(SUM(total), 0) AS total,
                    COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cached_tokens), 0) AS cached,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning
             FROM token_usages
             WHERE line IS NOT NULL AND line <> \'\'
             GROUP BY line
             ORDER BY total DESC, input DESC, output DESC, cached DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $items = [];
        foreach ($rows as $row) {
            $items[] = [
                'line' => $row['line'] ?? '',
                'events' => isset($row['events']) ? (int) $row['events'] : 0,
                'total' => isset($row['total']) ? (int) $row['total'] : 0,
                'input' => isset($row['input']) ? (int) $row['input'] : 0,
                'output' => isset($row['output']) ? (int) $row['output'] : 0,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : 0,
            ];
        }

        return $items;
    }
}
