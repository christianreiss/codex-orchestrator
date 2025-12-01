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

class TokenUsageIngestRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    /**
     * Store a normalized usage ingest for auditing.
     *
     * @param ?int $hostId
     * @param int $entries
     * @param array{total:?int,input:?int,output:?int,cached:?int,reasoning:?int,cost?:?float} $totals
     * @param ?float $cost
     * @param ?string $payload Normalized payload JSON (already sanitized)
     * @param ?string $clientIp
     *
     * @return array{id:int,host_id:?int,entries:int,total:?int,input:?int,output:?int,cached:?int,reasoning:?int,cost:?float,client_ip:?string,payload:?string,created_at:string}
     */
    public function record(?int $hostId, int $entries, array $totals, ?float $cost, ?string $payload, ?string $clientIp = null): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO token_usage_ingests (host_id, entries, total, input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost, client_ip, payload, created_at)
             VALUES (:host_id, :entries, :total, :input_tokens, :output_tokens, :cached_tokens, :reasoning_tokens, :cost, :client_ip, :payload, :created_at)'
        );

        $createdAt = gmdate(DATE_ATOM);
        $statement->execute([
            'host_id' => $hostId,
            'entries' => $entries,
            'total' => $totals['total'] ?? null,
            'input_tokens' => $totals['input'] ?? null,
            'output_tokens' => $totals['output'] ?? null,
            'cached_tokens' => $totals['cached'] ?? null,
            'reasoning_tokens' => $totals['reasoning'] ?? null,
            'cost' => $cost,
            'client_ip' => $clientIp !== null && $clientIp !== '' ? substr($clientIp, 0, 64) : null,
            'payload' => $payload,
            'created_at' => $createdAt,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return [
            'id' => $id,
            'host_id' => $hostId,
            'entries' => $entries,
            'total' => isset($totals['total']) ? (int) $totals['total'] : null,
            'input' => isset($totals['input']) ? (int) $totals['input'] : null,
            'output' => isset($totals['output']) ? (int) $totals['output'] : null,
            'cached' => isset($totals['cached']) ? (int) $totals['cached'] : null,
            'reasoning' => isset($totals['reasoning']) ? (int) $totals['reasoning'] : null,
            'cost' => $cost,
            'client_ip' => $clientIp !== null && $clientIp !== '' ? substr($clientIp, 0, 64) : null,
            'payload' => $payload,
            'created_at' => $createdAt,
        ];
    }

    public function recent(int $limit = 50): array
    {
        $limit = max(1, min($limit, 500));
        $statement = $this->database->connection()->prepare(
            'SELECT tui.id,
                    tui.host_id,
                    h.fqdn AS fqdn,
                    tui.entries,
                    tui.total,
                    tui.input_tokens AS input,
                    tui.output_tokens AS output,
                    tui.cached_tokens AS cached,
                    tui.reasoning_tokens AS reasoning,
                    tui.cost,
                    tui.client_ip,
                    tui.payload,
                    tui.created_at
             FROM token_usage_ingests tui
             LEFT JOIN hosts h ON h.id = tui.host_id
             ORDER BY tui.created_at DESC, tui.id DESC
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
                'entries' => isset($row['entries']) ? (int) $row['entries'] : 0,
                'total' => isset($row['total']) ? (int) $row['total'] : null,
                'input' => isset($row['input']) ? (int) $row['input'] : null,
                'output' => isset($row['output']) ? (int) $row['output'] : null,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : null,
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : null,
                'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
                'client_ip' => $row['client_ip'] ?? null,
                'payload' => $row['payload'] ?? null,
                'created_at' => $row['created_at'] ?? null,
            ];
        }

        return $items;
    }

    /**
     * Paginate ingests with optional host/search filters and sorting.
     *
     * @return array{items:array<int,array>,total:int,page:int,per_page:int,pages:int}
     */
    public function search(
        ?string $query = null,
        ?int $hostId = null,
        int $page = 1,
        int $perPage = 50,
        string $sort = 'created_at',
        string $direction = 'desc'
    ): array {
        $page = max(1, $page);
        $perPage = max(1, min($perPage, 200));
        $offset = ($page - 1) * $perPage;

        $sort = strtolower(trim($sort));
        $direction = strtolower($direction) === 'asc' ? 'ASC' : 'DESC';

        $sortable = [
            'created_at' => 'tui.created_at',
            'entries' => 'tui.entries',
            'total' => 'tui.total',
            'input' => 'tui.input_tokens',
            'output' => 'tui.output_tokens',
            'cached' => 'tui.cached_tokens',
            'reasoning' => 'tui.reasoning_tokens',
            'cost' => 'tui.cost',
            'host' => 'h.fqdn',
            'client_ip' => 'tui.client_ip',
            'id' => 'tui.id',
        ];

        $orderBy = $sortable[$sort] ?? $sortable['created_at'];

        $where = [];
        $params = [];

        if ($hostId !== null) {
            $where[] = 'tui.host_id = :host_id';
            $params['host_id'] = $hostId;
        }

        $searchTerm = $query !== null ? trim($query) : '';
        $searchIsNumeric = $searchTerm !== '' && ctype_digit($searchTerm);
        if ($searchTerm !== '') {
            $where[] = '(LOWER(h.fqdn) LIKE :search OR LOWER(tui.client_ip) LIKE :search' . ($searchIsNumeric ? ' OR tui.id = :search_id OR tui.host_id = :search_id' : '') . ')';
            $params['search'] = '%' . strtolower($searchTerm) . '%';
            if ($searchIsNumeric) {
                $params['search_id'] = (int) $searchTerm;
            }
        }

        $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        $countSql = 'SELECT COUNT(*) FROM token_usage_ingests tui LEFT JOIN hosts h ON h.id = tui.host_id ' . $whereSql;
        $countStmt = $this->database->connection()->prepare($countSql);
        foreach ($params as $key => $value) {
            $countStmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $countStmt->execute();
        $total = (int) $countStmt->fetchColumn();

        $sql = 'SELECT tui.id,
                       tui.host_id,
                       h.fqdn AS fqdn,
                       tui.entries,
                       tui.total,
                       tui.input_tokens AS input,
                       tui.output_tokens AS output,
                       tui.cached_tokens AS cached,
                       tui.reasoning_tokens AS reasoning,
                       tui.cost,
                       tui.client_ip,
                       tui.payload,
                       tui.created_at
                FROM token_usage_ingests tui
                LEFT JOIN hosts h ON h.id = tui.host_id
                ' . $whereSql . '
                ORDER BY ' . $orderBy . ' ' . $direction . ', tui.id ' . $direction . '
                LIMIT :limit OFFSET :offset';

        $stmt = $this->database->connection()->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $stmt->bindValue('limit', $perPage, PDO::PARAM_INT);
        $stmt->bindValue('offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $items = [];
        foreach ($rows as $row) {
            $items[] = [
                'id' => isset($row['id']) ? (int) $row['id'] : null,
                'host_id' => isset($row['host_id']) ? (int) $row['host_id'] : null,
                'fqdn' => $row['fqdn'] ?? null,
                'entries' => isset($row['entries']) ? (int) $row['entries'] : 0,
                'total' => isset($row['total']) ? (int) $row['total'] : null,
                'input' => isset($row['input']) ? (int) $row['input'] : null,
                'output' => isset($row['output']) ? (int) $row['output'] : null,
                'cached' => isset($row['cached']) ? (int) $row['cached'] : null,
                'reasoning' => isset($row['reasoning']) ? (int) $row['reasoning'] : null,
                'cost' => isset($row['cost']) ? (float) $row['cost'] : null,
                'client_ip' => $row['client_ip'] ?? null,
                'payload' => $row['payload'] ?? null,
                'created_at' => $row['created_at'] ?? null,
            ];
        }

        $pages = (int) ceil($total / $perPage);

        return [
            'items' => $items,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
            'pages' => $pages,
        ];
    }

    public function backfillCosts(float $inputPricePer1k, float $outputPricePer1k, float $cachedPricePer1k): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE token_usage_ingests
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
