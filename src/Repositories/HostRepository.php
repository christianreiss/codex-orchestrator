<?php

namespace App\Repositories;

use App\Database;
use PDO;

class HostRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function findByApiKey(string $apiKey): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE api_key = :api_key LIMIT 1'
        );
        $statement->execute(['api_key' => $apiKey]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ?: null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ?: null;
    }

    public function findByFqdn(string $fqdn): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE fqdn = :fqdn LIMIT 1'
        );
        $statement->execute(['fqdn' => $fqdn]);

        $host = $statement->fetch(PDO::FETCH_ASSOC);

        return $host ?: null;
    }

    public function create(string $fqdn, string $apiKey): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, created_at, updated_at) VALUES (:fqdn, :api_key, :status, :created_at, :updated_at)'
        );
        $statement->execute([
            'fqdn' => $fqdn,
            'api_key' => $apiKey,
            'status' => 'active',
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findByFqdn($fqdn);
    }

    public function rotateApiKey(int $hostId, string $apiKey): ?array
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET api_key = :api_key, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'api_key' => $apiKey,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);

        return $this->findById($hostId);
    }

    public function updateAuth(int $hostId, string $authJson, string $lastRefresh): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET auth_json = :auth_json, last_refresh = :last_refresh, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'auth_json' => $authJson,
            'last_refresh' => $lastRefresh,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function touch(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE hosts SET updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $hostId,
        ]);
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT * FROM hosts ORDER BY fqdn ASC'
        );

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function findInactiveBefore(string $cutoff): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM hosts WHERE updated_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    public function deleteByIds(array $ids): void
    {
        if (!$ids) {
            return;
        }

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $statement = $this->database->connection()->prepare(
            "DELETE FROM hosts WHERE id IN ({$placeholders})"
        );
        $statement->execute($ids);
    }
}
