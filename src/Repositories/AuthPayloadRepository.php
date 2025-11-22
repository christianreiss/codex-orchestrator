<?php

namespace App\Repositories;

use App\Database;
use PDO;

class AuthPayloadRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly AuthEntryRepository $entries
    ) {
    }

    public function create(string $lastRefresh, string $sha256, ?int $sourceHostId, array $entries, ?string $extrasJson = null): array
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO auth_payloads (last_refresh, sha256, source_host_id, body, created_at)
             VALUES (:last_refresh, :sha256, :source_host_id, :body, :created_at)'
        );

        $statement->execute([
            'last_refresh' => $lastRefresh,
            'sha256' => $sha256,
            'source_host_id' => $sourceHostId,
            'body' => $extrasJson,
            'created_at' => gmdate(DATE_ATOM),
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        $this->entries->replaceEntries($id, $entries);

        return $this->findByIdWithEntries($id);
    }

    public function findByIdWithEntries(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, last_refresh, sha256, source_host_id, body, created_at FROM auth_payloads WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $payload = $statement->fetch(PDO::FETCH_ASSOC);

        if (!$payload) {
            return null;
        }

        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }

    public function latest(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, last_refresh, sha256, source_host_id, body, created_at FROM auth_payloads ORDER BY created_at DESC, id DESC LIMIT 1'
        );
        $payload = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$payload) {
            return null;
        }

        $payload['entries'] = $this->entries->listByPayload((int) $payload['id']);

        return $payload;
    }
}
