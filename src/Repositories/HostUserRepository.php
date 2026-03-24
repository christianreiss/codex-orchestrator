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

class HostUserRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function record(int $hostId, string $username, ?string $hostname = null): void
    {
        $now = gmdate(DATE_ATOM);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO host_users (host_id, username, hostname, first_seen, last_seen)
             VALUES (:host_id, :username, :hostname, :first_seen, :last_seen)
             ON DUPLICATE KEY UPDATE hostname = VALUES(hostname), last_seen = VALUES(last_seen)'
        );
        $statement->execute([
            'host_id' => $hostId,
            'username' => $username,
            'hostname' => $hostname,
            'first_seen' => $now,
            'last_seen' => $now,
        ]);
    }

    public function listByHost(int $hostId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT username, hostname, first_seen, last_seen FROM host_users WHERE host_id = :host_id ORDER BY username ASC'
        );
        $statement->execute(['host_id' => $hostId]);

        return $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    /**
     * Return users for each of the given host IDs.
     *
     * @param  int[]  $hostIds
     * @return array<int, array>  keyed by host_id
     */
    public function listByHosts(array $hostIds): array
    {
        if ($hostIds === []) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($hostIds), '?'));
        $statement = $this->database->connection()->prepare(
            "SELECT host_id, username, hostname, first_seen, last_seen
             FROM host_users
             WHERE host_id IN ($placeholders)
             ORDER BY host_id, username ASC"
        );
        $statement->execute($hostIds);

        $result = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $result[(int) $row['host_id']][] = $row;
        }

        return $result;
    }

    public function deleteByHostId(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM host_users WHERE host_id = :host_id'
        );
        $statement->execute(['host_id' => $hostId]);
    }
}
