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

class HostAuthDigestRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function rememberDigests(int $hostId, array $digests, int $retain = 3, string $engine = Engine::DEFAULT): void
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
        $driver = strtolower((string) $connection->getAttribute(PDO::ATTR_DRIVER_NAME));

        $sql = $driver === 'sqlite'
            ? 'INSERT INTO host_auth_digests (host_id, engine, digest, last_seen, created_at)
               VALUES (:host_id, :engine, :digest, :last_seen, :created_at)
               ON CONFLICT(host_id, engine, digest) DO UPDATE SET
                   last_seen = excluded.last_seen'
            : 'INSERT INTO host_auth_digests (host_id, engine, digest, last_seen, created_at)
               VALUES (:host_id, :engine, :digest, :last_seen, :created_at)
               ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)';

        $statement = $connection->prepare($sql);

        foreach (array_keys($normalized) as $digest) {
            $statement->execute([
                'host_id' => $hostId,
                'engine' => Engine::validate($engine),
                'digest' => $digest,
                'last_seen' => $now,
                'created_at' => $now,
            ]);
        }

        $this->prune($hostId, $retain, $engine);
    }

    public function recentDigests(int $hostId, int $limit = 3, string $engine = Engine::DEFAULT): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT digest
             FROM host_auth_digests
             WHERE host_id = :host_id AND engine = :engine
             ORDER BY last_seen DESC, id DESC
             LIMIT :limit'
        );
        $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        $statement->bindValue('engine', Engine::validate($engine), PDO::PARAM_STR);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_COLUMN);

        return is_array($rows) ? $rows : [];
    }

    private function prune(int $hostId, int $retain, string $engine = Engine::DEFAULT): void
    {
        // Select only the IDs that fall outside the retention window by skipping
        // the first :retain rows via OFFSET, so we never load the rows we intend to keep.
        $statement = $this->database->connection()->prepare(
            'SELECT id
             FROM host_auth_digests
             WHERE host_id = :host_id AND engine = :engine
             ORDER BY last_seen DESC, id DESC
             LIMIT 99999 OFFSET :offset'
        );
        $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        $statement->bindValue('engine', Engine::validate($engine), PDO::PARAM_STR);
        $statement->bindValue('offset', $retain, PDO::PARAM_INT);
        $statement->execute();

        $toDelete = $statement->fetchAll(PDO::FETCH_COLUMN);
        if (!is_array($toDelete) || $toDelete === []) {
            return;
        }

        $placeholders = implode(',', array_fill(0, count($toDelete), '?'));
        $delete = $this->database->connection()->prepare(
            "DELETE FROM host_auth_digests WHERE id IN ({$placeholders})"
        );
        $delete->execute($toDelete);
    }

    public function deleteByHostId(int $hostId, ?string $engine = null): void
    {
        $sql = 'DELETE FROM host_auth_digests WHERE host_id = :host_id';
        $params = ['host_id' => $hostId];
        if ($engine !== null) {
            $sql .= ' AND engine = :engine';
            $params['engine'] = Engine::validate($engine);
        }
        $statement = $this->database->connection()->prepare($sql);
        $statement->execute($params);
    }

    /**
     * Return all digests grouped by host_id.
     *
     * @return array<int, array<int, string>>
     */
    public function byHostId(string $engine = Engine::DEFAULT): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT host_id, digest
             FROM host_auth_digests
             WHERE engine = :engine
             ORDER BY last_seen DESC, id DESC'
        );
        $statement->execute(['engine' => Engine::validate($engine)]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $grouped = [];
        foreach ($rows as $row) {
            $hostId = isset($row['host_id']) ? (int) $row['host_id'] : null;
            if ($hostId === null) {
                continue;
            }
            $grouped[$hostId][] = (string) $row['digest'];
        }
        return $grouped;
    }
}
