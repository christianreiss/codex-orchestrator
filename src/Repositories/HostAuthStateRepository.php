<?php

namespace App\Repositories;

use App\Database;
use PDO;

class HostAuthStateRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function findByHostId(int $hostId): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT host_id, payload_id, seen_digest, seen_at FROM host_auth_states WHERE host_id = :host_id LIMIT 1'
        );
        $statement->execute(['host_id' => $hostId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ?: null;
    }

    public function upsert(int $hostId, int $payloadId, string $digest): void
    {
        $statement = $this->database->connection()->prepare(
            'INSERT INTO host_auth_states (host_id, payload_id, seen_digest, seen_at)
             VALUES (:host_id, :payload_id, :seen_digest, :seen_at)
             ON DUPLICATE KEY UPDATE payload_id = VALUES(payload_id), seen_digest = VALUES(seen_digest), seen_at = VALUES(seen_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'payload_id' => $payloadId,
            'seen_digest' => $digest,
            'seen_at' => gmdate(DATE_ATOM),
        ]);
    }

    public function deleteByHostId(int $hostId): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM host_auth_states WHERE host_id = :host_id');
        $statement->execute(['host_id' => $hostId]);
    }
}
