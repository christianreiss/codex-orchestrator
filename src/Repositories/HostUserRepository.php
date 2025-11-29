<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
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

    public function deleteByHostId(int $hostId): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM host_users WHERE host_id = :host_id'
        );
        $statement->execute(['host_id' => $hostId]);
    }
}
