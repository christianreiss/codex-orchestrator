<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class JoplinNoteRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function find(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM joplin_notes_cache WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function findByJoplinId(string $joplinId): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM joplin_notes_cache WHERE joplin_id = :joplin_id LIMIT 1'
        );
        $statement->execute(['joplin_id' => $joplinId]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function all(?string $notebookId = null): array
    {
        $where = $notebookId !== null ? ' WHERE notebook_id = :notebook_id' : '';
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM joplin_notes_cache' . $where . ' ORDER BY updated_at DESC, id DESC'
        );
        $statement->execute($notebookId !== null ? ['notebook_id' => $notebookId] : []);

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function search(string $query, int $limit = 20): array
    {
        if (strlen($query) < 3) {
            $statement = $this->database->connection()->prepare(
                'SELECT * FROM joplin_notes_cache
                 WHERE title LIKE :query OR body LIKE :query
                 ORDER BY updated_at DESC, id DESC
                 LIMIT :limit'
            );
            $statement->bindValue('query', '%' . $query . '%');
            $statement->bindValue('limit', $limit, PDO::PARAM_INT);
            $statement->execute();
        } else {
            $statement = $this->database->connection()->prepare(
                'SELECT * FROM joplin_notes_cache
                 WHERE MATCH(title, body) AGAINST(:query IN BOOLEAN MODE)
                 ORDER BY MATCH(title, body) AGAINST(:query IN BOOLEAN MODE) DESC
                 LIMIT :limit'
            );
            $statement->bindValue('query', $query);
            $statement->bindValue('limit', $limit, PDO::PARAM_INT);
            $statement->execute();
        }

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function upsert(string $joplinId, string $title, string $body, string $notebookId, ?array $tags, string $parentId, string $syncedAt): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO joplin_notes_cache (joplin_id, title, body, notebook_id, tags_json, parent_id, synced_at, created_at, updated_at)
             VALUES (:joplin_id, :title, :body, :notebook_id, :tags_json, :parent_id, :synced_at, :created_at, :updated_at)
             ON DUPLICATE KEY UPDATE
                 title = VALUES(title),
                 body = VALUES(body),
                 notebook_id = VALUES(notebook_id),
                 tags_json = VALUES(tags_json),
                 parent_id = VALUES(parent_id),
                 synced_at = VALUES(synced_at),
                 updated_at = VALUES(updated_at)'
        );
        $statement->execute([
            'joplin_id' => $joplinId,
            'title' => $title,
            'body' => $body,
            'notebook_id' => $notebookId,
            'tags_json' => json_encode($tags ?? []),
            'parent_id' => $parentId,
            'synced_at' => $syncedAt,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findByJoplinId($joplinId) ?? [];
    }

    public function deleteByJoplinId(string $joplinId): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM joplin_notes_cache WHERE joplin_id = :joplin_id'
        );
        $statement->execute(['joplin_id' => $joplinId]);

        return $statement->rowCount() > 0;
    }

    public function oldestSyncedAt(): ?string
    {
        $statement = $this->database->connection()->query(
            'SELECT MIN(synced_at) FROM joplin_notes_cache'
        );

        $value = $statement->fetchColumn();

        return is_string($value) ? $value : null;
    }

    public function truncate(): void
    {
        $this->database->connection()->exec('DELETE FROM joplin_notes_cache');
    }
}
