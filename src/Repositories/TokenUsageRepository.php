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
        ?float $cost,
        ?string $model,
        ?string $line,
        ?int $ingestId = null
    ): void {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO token_usages (host_id, ingest_id, total, input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost, model, line, created_at)
             VALUES (:host_id, :ingest_id, :total, :input_tokens, :output_tokens, :cached_tokens, :reasoning_tokens, :cost, :model, :line, :created_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'ingest_id' => $ingestId,
            'total' => $total,
            'input_tokens' => $input,
            'output_tokens' => $output,
            'cached_tokens' => $cached,
            'reasoning_tokens' => $reasoning,
            'cost' => $cost,
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
                       COALESCE(SUM(cost), 0) AS cost,
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
            'cost' => isset($row['cost']) ? (float) $row['cost'] : 0.0,
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
                    COALESCE(SUM(cost), 0) AS cost,
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
                'cost' => isset($row['cost']) ? (float) $row['cost'] : 0.0,
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
                    COALESCE(SUM(cost), 0) AS cost,
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
            'cost' => isset($row['cost']) ? (float) $row['cost'] : 0.0,
            'events' => isset($row['events']) ? (int) $row['events'] : 0,
        ];
    }

    public function totalsForHostRange(int $hostId, string $startIso, string $endIso): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT COALESCE(SUM(total), 0) AS total,
                    COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cached_tokens), 0) AS cached,
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
                    COALESCE(SUM(cost), 0) AS cost,
                    COUNT(*) AS events
             FROM token_usages
             WHERE host_id = :host_id AND created_at >= :start AND created_at < :end'
        );
        $statement->execute([
            'host_id' => $hostId,
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
            'cost' => isset($row['cost']) ? (float) $row['cost'] : 0.0,
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
            'SELECT ingest_id, total, input_tokens AS input, output_tokens AS output, cached_tokens AS cached, reasoning_tokens AS reasoning, cost, model, line, created_at
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
            'ingest_id' => isset($row['ingest_id']) ? (int) $row['ingest_id'] : null,
            'total' => isset($row['total']) ? (int) $row['total'] : null,
            'input' => isset($row['input']) ? (int) $row['input'] : null,
            'output' => isset($row['output']) ? (int) $row['output'] : null,
            'cached' => isset($row['cached']) ? (int) $row['cached'] : null,
            'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : null,
            'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
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
                    tu.cost,
                    tu.ingest_id,
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
                'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
                'ingest_id' => isset($row['ingest_id']) ? (int) $row['ingest_id'] : null,
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
                    COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
                    COALESCE(SUM(cost), 0) AS cost
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
                'cost' => isset($row['cost']) ? (float) $row['cost'] : 0.0,
            ];
        }

        return $items;
    }

    public function firstRecordedAt(): ?string
    {
        $statement = $this->database->connection()->query(
            'SELECT created_at FROM token_usages ORDER BY created_at ASC, id ASC LIMIT 1'
        );
        $row = $statement->fetch(PDO::FETCH_ASSOC) ?: null;

        if (!$row || !isset($row['created_at'])) {
            return null;
        }

        return (string) $row['created_at'];
    }

    public function dailyTotalsSince(string $startIso): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT SUBSTRING(created_at, 1, 10) AS day,
                    COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cached_tokens), 0) AS cached
             FROM token_usages
             WHERE created_at >= :start
             GROUP BY day
             ORDER BY day ASC'
        );
        $statement->execute(['start' => $startIso]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $results = [];
        foreach ($rows as $row) {
            if (!isset($row['day'])) {
                continue;
            }
            $results[] = [
                'date' => (string) $row['day'],
                'input' => isset($row['input']) ? (int) $row['input'] : 0,
                'output' => isset($row['output']) ? (int) $row['output'] : 0,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : 0,
            ];
        }

        return $results;
    }

    public function backfillCosts(float $inputPricePer1k, float $outputPricePer1k, float $cachedPricePer1k): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE token_usages
             SET cost = (COALESCE(input_tokens, 0) / 1000) * :input_price
                      + (COALESCE(output_tokens, 0) / 1000) * :output_price
                      + (COALESCE(cached_tokens, 0) / 1000) * :cached_price
             WHERE cost IS NULL'
        );

        $statement->execute([
            'input_price' => $inputPricePer1k,
            'output_price' => $outputPricePer1k,
            'cached_price' => $cachedPricePer1k,
        ]);
    }
}
