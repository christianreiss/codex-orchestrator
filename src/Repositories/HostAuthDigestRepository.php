<?php

namespace App\Repositories;

use App\Database;
use PDO;

class HostAuthDigestRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function rememberDigests(int $hostId, array $digests, int $retain = 3): void
    {
        $normalized = [];
        foreach ($digests as $digest) {
            if (!is_string($digest)) {
                continue;
            }

            $trimmed = trim($digest);
            if ($trimmed === '') {
                continue;
            }

            $normalized[$trimmed] = true;
        }

        if (!$normalized) {
            return;
        }

        $now = gmdate(DATE_ATOM);
        $connection = $this->database->connection();

        $statement = $connection->prepare(
            'INSERT INTO host_auth_digests (host_id, digest, last_seen, created_at) VALUES (:host_id, :digest, :last_seen, :created_at)
             ON CONFLICT(host_id, digest) DO UPDATE SET last_seen = excluded.last_seen'
        );

        foreach (array_keys($normalized) as $digest) {
            $statement->execute([
                'host_id' => $hostId,
                'digest' => $digest,
                'last_seen' => $now,
                'created_at' => $now,
            ]);
        }

        $this->prune($hostId, $retain);
    }

    public function recentDigests(int $hostId, int $limit = 3): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT digest FROM host_auth_digests WHERE host_id = :host_id ORDER BY last_seen DESC, id DESC LIMIT :limit'
        );
        $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_COLUMN);

        return is_array($rows) ? $rows : [];
    }

    private function prune(int $hostId, int $retain): void
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id FROM host_auth_digests WHERE host_id = :host_id ORDER BY last_seen DESC, id DESC'
        );
        $statement->execute(['host_id' => $hostId]);

        $ids = $statement->fetchAll(PDO::FETCH_COLUMN);
        if (!is_array($ids) || count($ids) <= $retain) {
            return;
        }

        $toDelete = array_slice($ids, $retain);
        $placeholders = implode(',', array_fill(0, count($toDelete), '?'));
        $delete = $this->database->connection()->prepare(
            "DELETE FROM host_auth_digests WHERE id IN ({$placeholders})"
        );
        $delete->execute($toDelete);
    }

    public function deleteByHostId(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM host_auth_digests WHERE host_id = :host_id'
        );
        $statement->execute(['host_id' => $hostId]);
    }
}
