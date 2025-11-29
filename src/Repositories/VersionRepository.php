<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Repositories;

use App\Database;
use PDO;

class VersionRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function get(string $name): ?string
    {
        $statement = $this->database->connection()->prepare(
            'SELECT version FROM versions WHERE name = :name LIMIT 1'
        );
        $statement->execute(['name' => $name]);

        $version = $statement->fetchColumn();

        return is_string($version) ? $version : null;
    }

    public function getWithMetadata(string $name): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT version, updated_at FROM versions WHERE name = :name LIMIT 1'
        );
        $statement->execute(['name' => $name]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (!$row || !isset($row['version'])) {
            return null;
        }

        return [
            'version' => $row['version'],
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }

    public function set(string $name, string $version): void
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO versions (name, version, updated_at) VALUES (:name, :version, :updated_at)
             ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at)'
        );
        $statement->execute([
            'name' => $name,
            'version' => $version,
            'updated_at' => $now,
        ]);
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT name, version FROM versions'
        );

        $rows = $statement->fetchAll(PDO::FETCH_KEY_PAIR);

        return is_array($rows) ? $rows : [];
    }

    public function getFlag(string $name, bool $default = false): bool
    {
        $value = $this->get($name);
        if ($value === null) {
            return $default;
        }
        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on'], true);
    }
}
