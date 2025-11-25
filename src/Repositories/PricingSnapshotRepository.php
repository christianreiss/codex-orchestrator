<?php

namespace App\Repositories;

use App\Database;
use PDO;

class PricingSnapshotRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function record(array $data): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO pricing_snapshots (model, currency, input_price_per_1k, output_price_per_1k, cached_price_per_1k, source_url, raw, fetched_at, created_at)
             VALUES (:model, :currency, :input_price_per_1k, :output_price_per_1k, :cached_price_per_1k, :source_url, :raw, :fetched_at, :created_at)'
        );

        $now = gmdate(DATE_ATOM);
        $statement->execute([
            'model' => $data['model'],
            'currency' => $data['currency'] ?? 'USD',
            'input_price_per_1k' => $data['input_price_per_1k'],
            'output_price_per_1k' => $data['output_price_per_1k'],
            'cached_price_per_1k' => $data['cached_price_per_1k'] ?? 0,
            'source_url' => $data['source_url'] ?? null,
            'raw' => $data['raw'] ?? null,
            'fetched_at' => $data['fetched_at'] ?? $now,
            'created_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return $this->findById($id);
    }

    public function latestForModel(string $model): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM pricing_snapshots WHERE model = :model ORDER BY fetched_at DESC, id DESC LIMIT 1'
        );
        $statement->execute(['model' => $model]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ? $this->normalizeRow($row) : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM pricing_snapshots WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ? $this->normalizeRow($row) : null;
    }

    private function normalizeRow(array $row): array
    {
        foreach (['id'] as $key) {
            if (isset($row[$key])) {
                $row[$key] = (int) $row[$key];
            }
        }
        foreach (['input_price_per_1k', 'output_price_per_1k', 'cached_price_per_1k'] as $key) {
            if (isset($row[$key])) {
                $row[$key] = (float) $row[$key];
            }
        }

        return $row;
    }
}
