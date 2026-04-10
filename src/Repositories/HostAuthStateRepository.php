<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use App\Support\Engine;
use PDO;

class HostAuthStateRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function findByHostId(int $hostId, string $engine = Engine::DEFAULT): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT host_id, payload_id, engine, seen_digest, seen_at
             FROM host_auth_states
             WHERE host_id = :host_id AND engine = :engine
             LIMIT 1'
        );
        $statement->execute([
            'host_id' => $hostId,
            'engine' => Engine::validate($engine),
        ]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ?: null;
    }

    public function upsert(int $hostId, int $payloadId, string $digest, string $engine = Engine::DEFAULT): void
    {
        $connection = $this->database->connection();
        $driver = strtolower((string) $connection->getAttribute(PDO::ATTR_DRIVER_NAME));
        $sql = $driver === 'sqlite'
            ? 'INSERT INTO host_auth_states (host_id, payload_id, engine, seen_digest, seen_at)
               VALUES (:host_id, :payload_id, :engine, :seen_digest, :seen_at)
               ON CONFLICT(host_id, engine) DO UPDATE SET
                   payload_id = excluded.payload_id,
                   seen_digest = excluded.seen_digest,
                   seen_at = excluded.seen_at'
            : 'INSERT INTO host_auth_states (host_id, payload_id, engine, seen_digest, seen_at)
               VALUES (:host_id, :payload_id, :engine, :seen_digest, :seen_at)
               ON DUPLICATE KEY UPDATE payload_id = VALUES(payload_id), seen_digest = VALUES(seen_digest), seen_at = VALUES(seen_at)';

        $statement = $connection->prepare($sql);

        $statement->execute([
            'host_id' => $hostId,
            'payload_id' => $payloadId,
            'engine' => Engine::validate($engine),
            'seen_digest' => $digest,
            'seen_at' => gmdate(DATE_ATOM),
        ]);
    }

    public function deleteByHostId(int $hostId, ?string $engine = null): void
    {
        $sql = 'DELETE FROM host_auth_states WHERE host_id = :host_id';
        $params = ['host_id' => $hostId];
        if ($engine !== null) {
            $sql .= ' AND engine = :engine';
            $params['engine'] = Engine::validate($engine);
        }
        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
    }
}
