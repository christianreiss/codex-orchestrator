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

class SkillRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function all(bool $includeDeleted = false): array
    {
        $sql = 'SELECT id, slug, sha256, display_name, description, updated_at, deleted_at FROM skills';
        if (!$includeDeleted) {
            $sql .= ' WHERE deleted_at IS NULL';
        }
        $sql .= ' ORDER BY slug ASC';

        $statement = $this->database->connection()->query($sql);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function findBySlug(string $slug): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, slug, sha256, display_name, description, manifest, source_host_id, created_at, updated_at, deleted_at
             FROM skills
             WHERE slug = :slug
             LIMIT 1'
        );

        $statement->execute(['slug' => $slug]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function upsert(
        string $slug,
        string $sha256,
        ?string $displayName,
        ?string $description,
        string $manifest,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO skills (slug, sha256, display_name, description, manifest, source_host_id, created_at, updated_at, deleted_at)
             VALUES (:slug, :sha256, :display_name, :description, :manifest, :source_host_id, :created_at, :updated_at, NULL)
             ON DUPLICATE KEY UPDATE
                sha256 = VALUES(sha256),
                display_name = VALUES(display_name),
                description = VALUES(description),
                manifest = VALUES(manifest),
                source_host_id = VALUES(source_host_id),
                deleted_at = NULL,
                updated_at = VALUES(updated_at)'
        );

        $statement->execute([
            'slug' => $slug,
            'sha256' => $sha256,
            'display_name' => $displayName,
            'description' => $description,
            'manifest' => $manifest,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findBySlug($slug) ?? [];
    }

    public function delete(string $slug): bool
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE skills SET deleted_at = :deleted_at WHERE slug = :slug'
        );

        $statement->execute([
            'deleted_at' => gmdate(DATE_ATOM),
            'slug' => $slug,
        ]);

        return $statement->rowCount() > 0;
    }
}
